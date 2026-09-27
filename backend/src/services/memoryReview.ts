import { GoogleGenAI } from "@google/genai";
import { getPool } from "../db.js";

// ---------------------------------------------------------------------
// Post-conversation memory review.
//
// Gemini proposes candidate personal-context facts from a parent's own
// words in a voice transcript. The backend is the final authority: every
// candidate is independently re-validated before anything is stored, and
// Gemini's self-reported flags (explicitlyStated/stable/medical/uncertain)
// are never trusted on their own.
//
// Local to this reviewer only — unrelated Gemini-powered features
// (document extraction, trivia, schedule points) keep their own models.
// ---------------------------------------------------------------------

const REVIEW_MODEL = "gemini-3.8-flash";
const MAX_FACT_LENGTH = 300;

export const ALLOWED_MEMORY_CATEGORIES = [
  "family",
  "friend",
  "pet",
  "interest",
  "preference",
  "routine",
  "home",
  "other",
] as const;
type MemoryCategory = (typeof ALLOWED_MEMORY_CATEGORIES)[number];

const UNCERTAINTY_PHRASES = [
  "maybe",
  "might",
  "i think",
  "possibly",
  "not sure",
  "probably",
  "perhaps",
  "could be",
  "i believe",
  "i guess",
  "seems like",
  "i suppose",
];

export interface TranscriptTurn {
  index: number;
  role: string;
  message: string | null;
}

// Based on the actual stored ElevenLabs transcript shape (verified directly
// against real conversation rows): an array of turn objects, each with at
// least `role` ("agent" | "user") and `message` (string | null — null for
// turns that were tool calls rather than speech).
export function parseTranscriptTurns(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const role = typeof record.role === "string" ? record.role : "unknown";
    const message = typeof record.message === "string" ? record.message : null;
    return { index, role, message };
  });
}

interface MemoryCandidate {
  fact: string;
  category: string;
  sourceTurnIndex: number;
  explicitlyStated: boolean;
  stable: boolean;
  medical: boolean;
  uncertain: boolean;
  decision: "store" | "ignore" | "needs_confirmation";
}

const MEMORY_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fact: { type: "string" },
          category: { type: "string", enum: [...ALLOWED_MEMORY_CATEGORIES] },
          sourceTurnIndex: { type: "integer" },
          explicitlyStated: { type: "boolean" },
          stable: { type: "boolean" },
          medical: { type: "boolean" },
          uncertain: { type: "boolean" },
          decision: { type: "string", enum: ["store", "ignore", "needs_confirmation"] },
        },
        required: [
          "fact",
          "category",
          "sourceTurnIndex",
          "explicitlyStated",
          "stable",
          "medical",
          "uncertain",
          "decision",
        ],
      },
    },
  },
  required: ["candidates"],
};

function buildReviewPrompt(turns: TranscriptTurn[]): string {
  const transcriptForModel = turns.map((t) => ({ index: t.index, role: t.role, message: t.message }));

  return `You are reviewing a transcript of a voice conversation between a parent and Yupia, a care-companion voice assistant, to decide what (if anything) should become a durable personal-context memory in the parent's profile.

Each transcript turn has an index, a role ("user" = the parent speaking, "agent" = Yupia speaking), and a message (may be null for a turn with no recorded speech, such as a tool call).

ONLY the parent's own words (role "user") can ever support a memory. Never propose a memory based only on something the agent (Yupia) said, inferred, or suggested, even if the parent did not correct it.

For each potential fact, decide:
- explicitlyStated: true only if the parent stated it directly and plainly, not implied or guessed.
- stable: true only if it is a durable fact about the parent's life (a family member's name, a hobby, a pet, a preference, a friendship). False for temporary states ("I have a headache today", "I'm tired right now", "I'm going out later").
- medical: true if the fact is medical or clinical in nature (symptoms, diagnoses, medications, treatments, appointments). Medical facts must NEVER be proposed for storage here — medications, appointments, and documents already have their own dedicated sources of truth.
- uncertain: true if the parent expressed doubt, hedging, or speculation ("I think", "maybe", "not sure").
- category: exactly one of: ${ALLOWED_MEMORY_CATEGORIES.join(", ")}.
- decision:
  - "store": only for an explicit, stable, non-medical, non-uncertain, genuinely new personal-context fact.
  - "ignore": temporary states, agent-only statements, uncertain statements, medical content, small talk, or anything already obviously redundant.
  - "needs_confirmation": plausibly useful but not clearly meeting the "store" bar.

Many conversations should correctly produce zero candidates, or zero candidates with decision "store". Do not invent facts. Do not pad the list. An empty candidates array is a correct and expected answer when nothing qualifies.

Transcript:
${JSON.stringify(transcriptForModel)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpStatus(error: unknown): number | null {
  const details = error as { status?: unknown; code?: unknown } | null;
  const status = details?.status ?? details?.code;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function getErrorCode(error: unknown): string | null {
  const details = error as { status?: unknown; code?: unknown; message?: unknown } | null;
  let code = details?.code ?? details?.status;
  if (typeof details?.message === "string") {
    try {
      code = JSON.parse(details.message)?.error?.status ?? code;
    } catch {
      code = code ?? details.message;
    }
  }
  return typeof code === "string" &&
    /^(INVALID_ARGUMENT|UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)$/.test(code)
    ? code
    : null;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof SyntaxError) return false;
  const status = getHttpStatus(error);
  if (status !== null) return status === 429 || status === 503;
  const code = getErrorCode(error);
  return code === "RESOURCE_EXHAUSTED" || code === "UNAVAILABLE";
}

type ReviewFailureStage = "configuration" | "api_call" | "response_text" | "json_parse" | "response_shape";

export type ReviewCallResult =
  | { ok: true; candidates: MemoryCandidate[] }
  | { ok: false; reason: string; stage: ReviewFailureStage; httpStatus: number | null; errorCode: string | null };

function reviewFailure(stage: ReviewFailureStage, reason: string, error?: unknown): ReviewCallResult {
  // Only fixed reasons and allowlisted codes leave this layer, never SDK payloads.
  return { ok: false, reason, stage, httpStatus: getHttpStatus(error), errorCode: getErrorCode(error) };
}

const RETRY_DELAYS_MS = [1500, 4000];

export async function callGeminiForReview(
  turns: TranscriptTurn[],
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ReviewCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return reviewFailure("configuration", "GEMINI_API_KEY is not configured");
  }

  let client: GoogleGenAI;
  try {
    client = new GoogleGenAI({ apiKey });
  } catch (error) {
    return reviewFailure("configuration", "reviewer client initialization failed", error);
  }
  const prompt = buildReviewPrompt(turns);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let stage: ReviewFailureStage = "api_call";
    try {
      const response = await client.models.generateContent({
        model: REVIEW_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: MEMORY_REVIEW_SCHEMA,
          temperature: 0.1,
        },
      });

      stage = "response_text";
      const text = response.text;
      if (!text) {
        return reviewFailure(stage, "empty response from reviewer model");
      }

      stage = "json_parse";
      const parsed = JSON.parse(text) as { candidates?: MemoryCandidate[] } | null;
      stage = "response_shape";
      if (!Array.isArray(parsed?.candidates)) {
        return reviewFailure(stage, "reviewer model returned an invalid shape");
      }

      return { ok: true, candidates: parsed.candidates };
    } catch (error) {
      const transient = stage === "api_call" && isTransientError(error);
      if (!transient || attempt === 2) {
        return reviewFailure(stage, transient ? "reviewer model unavailable after retries" : "reviewer model call failed", error);
      }
      console.warn("Conversation memory reviewer retrying", {
        model: REVIEW_MODEL,
        stage,
        httpStatus: getHttpStatus(error),
        errorCode: getErrorCode(error),
        nextAttempt: attempt + 2,
      });
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }

  return reviewFailure("api_call", "reviewer model call failed");
}

function normalizeFact(fact: string): string {
  return fact
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

function containsUncertaintyLanguage(fact: string): boolean {
  const lower = fact.toLowerCase();
  return UNCERTAINTY_PHRASES.some((phrase) => lower.includes(phrase));
}

function isAllowedCategory(value: string): value is MemoryCategory {
  return (ALLOWED_MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export interface ValidatedMemory {
  fact: string;
  normalizedFact: string;
  category: MemoryCategory;
  sourceTurnIndex: number;
}

export type RejectionReason =
  | "not_store_decision"
  | "invalid_source_turn"
  | "source_turn_not_user"
  | "invalid_category"
  | "not_explicitly_stated"
  | "not_stable"
  | "medical"
  | "uncertain_flag"
  | "uncertainty_language"
  | "empty_fact"
  | "fact_too_long";

// Backend is the final authority: every field is re-checked independently,
// even the ones Gemini already claims to have verified.
export function validateCandidate(
  candidate: MemoryCandidate,
  turns: TranscriptTurn[]
): { valid: true; memory: ValidatedMemory } | { valid: false; reason: RejectionReason } {
  if (candidate.decision !== "store") {
    return { valid: false, reason: "not_store_decision" };
  }

  if (
    !Number.isInteger(candidate.sourceTurnIndex) ||
    candidate.sourceTurnIndex < 0 ||
    candidate.sourceTurnIndex >= turns.length
  ) {
    return { valid: false, reason: "invalid_source_turn" };
  }

  if (turns[candidate.sourceTurnIndex].role !== "user") {
    return { valid: false, reason: "source_turn_not_user" };
  }

  if (!isAllowedCategory(candidate.category)) {
    return { valid: false, reason: "invalid_category" };
  }

  if (candidate.explicitlyStated !== true) {
    return { valid: false, reason: "not_explicitly_stated" };
  }

  if (candidate.stable !== true) {
    return { valid: false, reason: "not_stable" };
  }

  if (candidate.medical !== false) {
    return { valid: false, reason: "medical" };
  }

  if (candidate.uncertain !== false) {
    return { valid: false, reason: "uncertain_flag" };
  }

  const fact = candidate.fact.trim();
  if (fact.length === 0) {
    return { valid: false, reason: "empty_fact" };
  }
  if (fact.length > MAX_FACT_LENGTH) {
    return { valid: false, reason: "fact_too_long" };
  }
  if (containsUncertaintyLanguage(fact)) {
    return { valid: false, reason: "uncertainty_language" };
  }

  return {
    valid: true,
    memory: {
      fact,
      normalizedFact: normalizeFact(fact),
      category: candidate.category,
      sourceTurnIndex: candidate.sourceTurnIndex,
    },
  };
}

export interface StoreMemoryResult {
  stored: number;
  skippedDuplicate: number;
  rejected: number;
}

// Rows are only ever inserted, never updated — an apparently contradicting
// fact is simply added alongside the existing one rather than silently
// overwriting it. Deterministic dedup on (parent_id, normalized_fact) is
// enforced both here and by a unique index at the database level.
export async function storeValidatedMemories(
  parentId: string,
  conversationRowId: string | null,
  memories: ValidatedMemory[]
): Promise<StoreMemoryResult> {
  const pool = getPool();
  let stored = 0;
  let skippedDuplicate = 0;

  for (const memory of memories) {
    const existing = await pool.query(
      "SELECT 1 FROM parent_memories WHERE parent_id = $1 AND normalized_fact = $2",
      [parentId, memory.normalizedFact]
    );
    if (existing.rows.length > 0) {
      skippedDuplicate += 1;
      continue;
    }

    try {
      await pool.query(
        `INSERT INTO parent_memories
           (parent_id, fact, normalized_fact, category, source_conversation_id, source_turn_index)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [parentId, memory.fact, memory.normalizedFact, memory.category, conversationRowId, memory.sourceTurnIndex]
      );
      stored += 1;
    } catch (error) {
      // Unique-index race (two reviews of the same fact landing concurrently) — treat as a duplicate, not a failure.
      const code = (error as { code?: string })?.code;
      if (code === "23505") {
        skippedDuplicate += 1;
        continue;
      }
      throw error;
    }
  }

  return { stored, skippedDuplicate, rejected: 0 };
}

export type MemoryReviewOutcome =
  | { status: "reviewed"; stored: number; skippedDuplicate: number; rejected: number; evaluated: number }
  | { status: "already_reviewed" }
  | { status: "no_user_turns" }
  | { status: "failed"; reason: string }
  | { status: "not_found" };

// The single entry point: idempotent, retryable, and never marks a
// conversation "reviewed" unless the backend actually finished validating
// (or the reviewer legitimately found nothing to review).
export async function reviewConversationMemory(
  parentId: string,
  conversationId: string
): Promise<MemoryReviewOutcome> {
  const pool = getPool();

  const row = await pool.query<{
    id: string;
    transcript: unknown;
    memory_review_status: string;
  }>(
    `SELECT id, transcript, memory_review_status
     FROM voice_conversations
     WHERE elevenlabs_conversation_id = $1 AND parent_id = $2`,
    [conversationId, parentId]
  );

  const conversation = row.rows[0];
  if (!conversation) {
    return { status: "not_found" };
  }
  if (conversation.memory_review_status === "reviewed") {
    return { status: "already_reviewed" };
  }

  const turns = parseTranscriptTurns(conversation.transcript);
  const hasUserTurns = turns.some((t) => t.role === "user" && t.message);

  if (!hasUserTurns) {
    await pool.query(
      `UPDATE voice_conversations
       SET memory_review_status = 'reviewed', memory_reviewed_at = now(), memory_review_attempts = memory_review_attempts + 1
       WHERE id = $1`,
      [conversation.id]
    );
    return { status: "no_user_turns" };
  }

  const result = await callGeminiForReview(turns);

  if (!result.ok) {
    console.warn("Conversation memory review failed", {
      conversationId,
      parentId,
      stage: result.stage,
      category: result.reason,
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
    });
    await pool.query(
      `UPDATE voice_conversations
       SET memory_review_status = 'failed', memory_review_attempts = memory_review_attempts + 1
       WHERE id = $1`,
      [conversation.id]
    );
    return { status: "failed", reason: result.reason };
  }

  const validated: ValidatedMemory[] = [];
  let rejected = 0;
  for (const candidate of result.candidates) {
    const outcome = validateCandidate(candidate, turns);
    if (outcome.valid) {
      validated.push(outcome.memory);
    } else {
      rejected += 1;
    }
  }

  const storeResult = await storeValidatedMemories(parentId, conversation.id, validated);

  await pool.query(
    `UPDATE voice_conversations
     SET memory_review_status = 'reviewed', memory_reviewed_at = now(), memory_review_attempts = memory_review_attempts + 1
     WHERE id = $1`,
    [conversation.id]
  );

  return {
    status: "reviewed",
    stored: storeResult.stored,
    skippedDuplicate: storeResult.skippedDuplicate,
    rejected,
    evaluated: result.candidates.length,
  };
}

export interface ActiveMemory {
  fact: string;
  category: string;
}

export async function getActiveMemories(parentId: string): Promise<ActiveMemory[]> {
  const pool = getPool();
  const result = await pool.query<{ fact: string; category: string }>(
    "SELECT fact, category FROM parent_memories WHERE parent_id = $1 ORDER BY created_at ASC",
    [parentId]
  );
  return result.rows;
}
