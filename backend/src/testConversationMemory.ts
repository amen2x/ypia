import assert from "node:assert/strict";
import { getPool } from "./db.js";
import {
  callGeminiForReview,
  parseTranscriptTurns,
  validateCandidate,
  storeValidatedMemories,
  type TranscriptTurn,
} from "./services/memoryReview.js";

// Pure fixture-based tests for the backend validation rules (no Gemini calls).
// Only the dedup integration test touches the database, using a clearly-marked
// synthetic fact against the existing susan.demo@ypia.test parent, which it
// inserts and then deletes itself.

let failures = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`passed: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`failed: ${name}`);
    console.error(error);
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`passed: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`failed: ${name}`);
    console.error(error);
  }
}

const TURNS: TranscriptTurn[] = [
  { index: 0, role: "agent", message: "Hi! What can I help with?" },
  { index: 1, role: "user", message: "My son Mike calls me every Sunday afternoon." },
  { index: 2, role: "agent", message: "That's lovely." },
  { index: 3, role: "user", message: "I have a headache today." },
];

function baseCandidate(overrides: Partial<Parameters<typeof validateCandidate>[0]> = {}) {
  return {
    fact: "Her son Mike calls her every Sunday afternoon.",
    category: "family",
    sourceTurnIndex: 1,
    explicitlyStated: true,
    stable: true,
    medical: false,
    uncertain: false,
    decision: "store" as const,
    ...overrides,
  };
}

// A: a clean, valid candidate should be accepted.
test("A: valid explicit/stable/non-medical/non-uncertain user-turn fact is accepted", () => {
  const outcome = validateCandidate(baseCandidate(), TURNS);
  assert.equal(outcome.valid, true);
});

// B: decision "ignore" must never be stored.
test("B: decision=ignore is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ decision: "ignore" }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "not_store_decision");
});

// C: decision "needs_confirmation" must never be stored automatically.
test("C: decision=needs_confirmation is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ decision: "needs_confirmation" }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "not_store_decision");
});

// D: sourceTurnIndex must exist in the actual transcript.
test("D: out-of-bounds sourceTurnIndex is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ sourceTurnIndex: 99 }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "invalid_source_turn");
});

// E: no inference from agent statements — the source turn must be user-authored.
test("E: sourceTurnIndex pointing at an agent turn is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ sourceTurnIndex: 0 }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "source_turn_not_user");
});

// F: category must come from the backend allowlist only.
test("F: a category outside the allowlist is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ category: "medical_diagnosis" }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "invalid_category");
});

// G: implied/guessed facts (explicitlyStated=false) are rejected.
test("G: explicitlyStated=false is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ explicitlyStated: false }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "not_explicitly_stated");
});

// H: temporary states (stable=false) must not become durable memories.
test("H: stable=false (temporary state) is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ stable: false, sourceTurnIndex: 3, fact: "She has a headache today." }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "not_stable");
});

// I: medical information must never enter parent_memories.
test("I: medical=true is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ medical: true, sourceTurnIndex: 3, fact: "She has a headache today." }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "medical");
});

// J: uncertain statements must not be stored — both via Gemini's own flag and
// via the backend's independent uncertainty-language filter (which does not
// trust Gemini's self-reported uncertain=false).
test("J: uncertain=true is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ uncertain: true }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "uncertain_flag");
});

test("J2: uncertainty language in the fact text is rejected even if uncertain=false", () => {
  const outcome = validateCandidate(
    baseCandidate({ fact: "She thinks she might visit her sister sometime, not totally sure." }),
    TURNS
  );
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "uncertainty_language");
});

test("edge case: empty fact text is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ fact: "   " }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "empty_fact");
});

test("edge case: overly long fact text is rejected", () => {
  const outcome = validateCandidate(baseCandidate({ fact: "a".repeat(301) }), TURNS);
  assert.equal(outcome.valid, false);
  assert.equal((outcome as { reason: string }).reason, "fact_too_long");
});

test("transcript parser preserves original indices and role/message shape", () => {
  const raw = [
    { role: "agent", message: "hi" },
    { role: "user", message: null, tool_calls: [] },
    { role: "user", message: "hello" },
  ];
  const parsed = parseTranscriptTurns(raw);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].message, null);
  assert.equal(parsed[2].index, 2);
});

test("transcript parser returns an empty array for non-array input", () => {
  assert.deepEqual(parseTranscriptTurns(null), []);
  assert.deepEqual(parseTranscriptTurns(undefined), []);
  assert.deepEqual(parseTranscriptTurns({}), []);
});

const FAKE_API_KEY = "memory-test-key-not-a-real-secret";
const PRIVATE_ERROR_TEXT = "synthetic private payload never returned";

function reviewerResponse(text: string): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
}

function reviewerError(status: number, code: string): Response {
  return Response.json({ error: { code: status, status: code, message: `${FAKE_API_KEY} ${PRIVATE_ERROR_TEXT}` } }, { status });
}

async function mockReview(reply: (attempt: number) => Response) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalKey = process.env.GEMINI_API_KEY;
  const requests: { url: string; body: unknown }[] = [];
  const delays: number[] = [];
  const logs: unknown[][] = [];
  console.warn = (...values: unknown[]) => { logs.push(values); };
  process.env.GEMINI_API_KEY = FAKE_API_KEY;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
    return reply(requests.length);
  };
  try {
    const result = await callGeminiForReview(TURNS, async (ms) => { delays.push(ms); });
    const serialized = JSON.stringify({ result, logs });
    assert.equal(serialized.includes(FAKE_API_KEY), false);
    assert.equal(serialized.includes(PRIVATE_ERROR_TEXT), false);
    for (const turn of TURNS) {
      if (turn.message) assert.equal(JSON.stringify(logs).includes(turn.message), false);
    }
    return { result, requests, delays, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
}

async function testReviewerCalls() {
  await asyncTest("reviewer: real SDK sends existing model/schema and parses its text getter", async () => {
    const candidates = [baseCandidate()];
    const { result, requests, delays } = await mockReview(() => reviewerResponse(JSON.stringify({ candidates })));
    assert.deepEqual(result, { ok: true, candidates });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/models\/gemini-3\.8-flash:generateContent$/);
    const body = requests[0].body as { generationConfig: unknown; contents: { role: string; parts: { text: string }[] }[] };
    assert.deepEqual(body.generationConfig, {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object", additionalProperties: false, required: ["candidates"],
        properties: {
          candidates: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: {
                fact: { type: "string" },
                category: { type: "string", enum: ["family", "friend", "pet", "interest", "preference", "routine", "home", "other"] },
                sourceTurnIndex: { type: "integer" },
                explicitlyStated: { type: "boolean" }, stable: { type: "boolean" },
                medical: { type: "boolean" }, uncertain: { type: "boolean" },
                decision: { type: "string", enum: ["store", "ignore", "needs_confirmation"] },
              },
              required: ["fact", "category", "sourceTurnIndex", "explicitlyStated", "stable", "medical", "uncertain", "decision"],
            },
          },
        },
      },
    });
    assert.equal(body.contents[0].role, "user");
    assert.ok(body.contents[0].parts[0].text.includes(JSON.stringify(TURNS)));
    assert.deepEqual(delays, []);
  });

  for (const [label, text, stage] of [
    ["empty text", "", "response_text"],
    ["null response", "null", "response_shape"],
    ["missing candidates", "{}", "response_shape"],
    ["non-array candidates", '{"candidates":null}', "response_shape"],
    ["malformed JSON mentioning UNAVAILABLE", `UNAVAILABLE ${FAKE_API_KEY} ${PRIVATE_ERROR_TEXT}`, "json_parse"],
  ]) {
    await asyncTest(`reviewer: ${label} is terminal`, async () => {
      const { result, requests, delays } = await mockReview(() => reviewerResponse(text));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.stage, stage);
      assert.equal(result.httpStatus, null);
      assert.equal(result.errorCode, null);
      assert.equal(requests.length, 1);
      assert.deepEqual(delays, []);
    });
  }

  for (const status of [400, 401, 403]) {
    await asyncTest(`reviewer: HTTP ${status} is terminal even with UNAVAILABLE error code`, async () => {
      const { result, requests, delays } = await mockReview(() => reviewerError(status, "UNAVAILABLE"));
      assert.deepEqual(result, { ok: false, reason: "reviewer model call failed", stage: "api_call", httpStatus: status, errorCode: "UNAVAILABLE" });
      assert.equal(requests.length, 1);
      assert.deepEqual(delays, []);
    });
  }

  for (const [status, code] of [[429, "RESOURCE_EXHAUSTED"], [503, "UNAVAILABLE"]] as const) {
    await asyncTest(`reviewer: HTTP ${status} stops after three attempts with bounded delays`, async () => {
      const { result, requests, delays, logs } = await mockReview(() => reviewerError(status, code));
      assert.deepEqual(result, { ok: false, reason: "reviewer model unavailable after retries", stage: "api_call", httpStatus: status, errorCode: code });
      assert.equal(requests.length, 3);
      assert.deepEqual(delays, [1500, 4000]);
      assert.deepEqual(logs, [2, 3].map((nextAttempt) => [
        "Conversation memory reviewer retrying",
        { model: "gemini-3.8-flash", stage: "api_call", httpStatus: status, errorCode: code, nextAttempt },
      ]));
    });
  }

  await asyncTest("reviewer: successful retry stops further requests", async () => {
    const { result, requests, delays } = await mockReview((attempt) => attempt === 1
      ? reviewerError(503, "UNAVAILABLE") : reviewerResponse('{"candidates":[]}'));
    assert.deepEqual(result, { ok: true, candidates: [] });
    assert.equal(requests.length, 2);
    assert.deepEqual(delays, [1500]);
  });

  for (const code of ["RESOURCE_EXHAUSTED", "UNAVAILABLE"]) {
    await asyncTest(`reviewer: symbolic ${code} without HTTP status is transient`, async () => {
      const { result, requests, delays } = await mockReview(() => {
        throw Object.assign(new Error(`${FAKE_API_KEY} ${PRIVATE_ERROR_TEXT}`), { code });
      });
      assert.deepEqual(result, { ok: false, reason: "reviewer model unavailable after retries", stage: "api_call", httpStatus: null, errorCode: code });
      assert.equal(requests.length, 3);
      assert.deepEqual(delays, [1500, 4000]);
    });
  }

  await asyncTest("reviewer: programming TypeError is terminal even with transient code", async () => {
    const { result, requests, delays } = await mockReview(() => {
      throw Object.assign(new TypeError(`${FAKE_API_KEY} ${PRIVATE_ERROR_TEXT}`), { code: "UNAVAILABLE" });
    });
    assert.deepEqual(result, { ok: false, reason: "reviewer model call failed", stage: "api_call", httpStatus: null, errorCode: "UNAVAILABLE" });
    assert.equal(requests.length, 1);
    assert.deepEqual(delays, []);
  });
}

async function main() {
  await testReviewerCalls();
  if (process.argv.includes("--offline")) {
    if (failures > 0) process.exitCode = 1;
    return;
  }
  const pool = getPool();

  const susanUser = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = 'susan.demo@ypia.test'"
  );
  if (susanUser.rows.length > 0) {
    const parentRow = await pool.query<{ id: string }>(
      "SELECT id FROM parents WHERE user_id = $1",
      [susanUser.rows[0].id]
    );
    const parentId = parentRow.rows[0]?.id;

    if (parentId) {
      await asyncTest("dedup: storing the same normalized fact twice only inserts once", async () => {
        const fact = "MEMORY TEST FIXTURE — dedup check, safe to delete.";
        try {
          const first = await storeValidatedMemories(parentId, null, [
            { fact, normalizedFact: fact.toLowerCase().trim().replace(/[.!?]+$/g, ""), category: "other", sourceTurnIndex: 0 },
          ]);
          const second = await storeValidatedMemories(parentId, null, [
            { fact, normalizedFact: fact.toLowerCase().trim().replace(/[.!?]+$/g, ""), category: "other", sourceTurnIndex: 0 },
          ]);
          assert.equal(first.stored, 1);
          assert.equal(second.stored, 0);
          assert.equal(second.skippedDuplicate, 1);
        } finally {
          await pool.query(
            "DELETE FROM parent_memories WHERE parent_id = $1 AND fact = $2",
            [parentId, fact]
          );
        }
      });
    }
  }

  await pool.end();

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All conversation-memory tests passed.");
  }
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
