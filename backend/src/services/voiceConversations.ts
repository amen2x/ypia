import { getPool } from "../db.js";

export async function registerVoiceConversation(parentId: string, conversationId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO voice_conversations (parent_id, elevenlabs_conversation_id)
     VALUES ($1, $2)
     ON CONFLICT (elevenlabs_conversation_id) DO NOTHING`,
    [parentId, conversationId]
  );
}

export async function isConversationRegisteredToParent(
  parentId: string,
  conversationId: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    "SELECT 1 FROM voice_conversations WHERE elevenlabs_conversation_id = $1 AND parent_id = $2",
    [conversationId, parentId]
  );
  return (result.rowCount ?? 0) > 0;
}

interface ElevenLabsConversationDetails {
  status?: string;
  transcript?: unknown;
  main_language?: string | null;
  analysis?: { transcript_summary?: string | null } | null;
  metadata?: { start_time_unix_secs?: number; call_duration_secs?: number } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchConversationDetails(conversationId: string): Promise<ElevenLabsConversationDetails | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return null;
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { "xi-api-key": apiKey } }
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as ElevenLabsConversationDetails;
}

// node-postgres serializes a top-level JS array as a Postgres array literal, not JSON,
// even for a jsonb column — only plain objects get auto-JSON.stringify'd. A top-level
// array value (like the ElevenLabs transcript) must be explicitly stringified before
// binding, or Postgres ends up storing something other than the real JSON array.
export function prepareJsonbParam(value: unknown): string | null {
  return value !== undefined && value !== null ? JSON.stringify(value) : null;
}

export type SyncStatus = "synced" | "pending" | "not_owned" | "unavailable";

export async function syncVoiceConversation(
  parentId: string,
  conversationId: string
): Promise<SyncStatus> {
  const owned = await isConversationRegisteredToParent(parentId, conversationId);
  if (!owned) {
    return "not_owned";
  }

  const maxAttempts = 3;
  let details: ElevenLabsConversationDetails | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    details = await fetchConversationDetails(conversationId);
    if (!details) {
      return "unavailable";
    }

    if (details.status === "done" || details.transcript) {
      break;
    }

    if (attempt < maxAttempts - 1) {
      await sleep(1500);
    }
  }

  if (!details) {
    return "unavailable";
  }

  const startTimeSecs = details.metadata?.start_time_unix_secs;
  const durationSecs = details.metadata?.call_duration_secs;
  const startedAt = typeof startTimeSecs === "number" ? new Date(startTimeSecs * 1000) : null;
  const endedAt =
    typeof startTimeSecs === "number" && typeof durationSecs === "number"
      ? new Date((startTimeSecs + durationSecs) * 1000)
      : null;

  const transcriptParam = prepareJsonbParam(details.transcript);

  const pool = getPool();
  await pool.query(
    `UPDATE voice_conversations
     SET transcript = COALESCE($1::jsonb, transcript),
         summary = COALESCE($2, summary),
         main_language = COALESCE($3, main_language),
         started_at = COALESCE($4, started_at),
         ended_at = COALESCE($5, ended_at)
     WHERE elevenlabs_conversation_id = $6 AND parent_id = $7`,
    [
      transcriptParam,
      details.analysis?.transcript_summary ?? null,
      details.main_language ?? null,
      startedAt,
      endedAt,
      conversationId,
      parentId,
    ]
  );

  return details.status === "done" ? "synced" : "pending";
}
