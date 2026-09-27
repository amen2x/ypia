import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { getPool } from "./db.js";
import { buildReviewPayload, confirmDocument, DocumentAccessError, DocumentValidationError, parseAppointmentDateTime } from "./services/documentConfirmation.js";
import type { ExtractedDocument } from "./types.js";

// DB-backed tests use synthetic, clearly-marked ("ZZTEST ...") rows against the
// existing susan.demo@ypia.test parent, and clean up everything they insert.

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

function emptyDoc(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    documentType: "prescription",
    medications: [],
    appointments: [],
    followUps: [],
    instructions: [],
    ...overrides,
  };
}

// --- Pure fixture tests (no DB) ---

test("1: buildReviewPayload marks a fully empty extraction as isEmpty", () => {
  const review = buildReviewPayload(emptyDoc());
  assert.equal(review.isEmpty, true);
  assert.equal(review.medications.length, 0);
});

test("1b: buildReviewPayload never leaks rxnorm/model internals and adds friendly labels", () => {
  const review = buildReviewPayload(
    emptyDoc({ medications: [{ name: "Lisinopril", dose: "10 mg", frequency: "daily", status: "changed" }] }),
  );
  assert.equal(review.isEmpty, false);
  assert.equal(review.medications[0].statusLabel, "Dose or frequency changed");
  assert.equal((review.medications[0] as unknown as Record<string, unknown>).rxnorm, undefined);
  assert.equal(review.documentTypeLabel, "Prescription");
});

test("appointment parsing preserves explicit and corrected local date/time", () => {
  for (const date of ["October 15, 2026", "2026-10-15", "10/15/2026"]) {
    const parsed = parseAppointmentDateTime(date, "10:30 AM");
    assert.ok(parsed);
    assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes()], [2026, 9, 15, 10, 30]);
  }
});

test("appointment parsing rejects invalid, incomplete, and rollover values", () => {
  for (const [date, time] of [
    ["October 14, 2026", "25:90"], ["February 30, 2026", "10:30 AM"],
    ["2026-02-29", "10:30"], ["October 14", "10:30 AM"],
    ["2026-10-14", null], [null, "10:30 AM"], ["tomorrow", "10:30"],
    ["2026-10-14", "13:30 PM"], ["2026-10-14T10:30:00Z", "10:30"],
  ]) assert.equal(parseAppointmentDateTime(date, time), null);
});

// --- DB-backed integration tests ---

async function main() {
  await asyncTest("caregiver upload keeps its existing read-only response shape", async () => {
    const server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const draft = emptyDoc({ instructions: ["Synthetic upload response check"] });
      const form = new FormData();
      form.append("document", new Blob([JSON.stringify(draft)], { type: "application/json" }), "ZZTEST.json");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/documents`, { method: "POST", body: form });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.documentType, draft.documentType);
      assert.deepEqual(body.medications, []);
      assert.deepEqual(body.instructions, draft.instructions);
      assert.equal(body.documentId, undefined);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  if (process.argv.includes("--offline")) {
    if (failures > 0) process.exitCode = 1;
    console.log("Offline checks complete; database integration checks skipped.");
    return;
  }

  const pool = getPool();

  const susanUser = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'susan.demo@ypia.test'");
  const otherUser = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'test@gmail.com'");

  if (susanUser.rows.length === 0) {
    console.log("Synthetic demo parent susan.demo@ypia.test not found — skipping DB-backed tests.");
  } else {
    const susanUserId = susanUser.rows[0].id;
    const parentResult = await pool.query<{ id: string }>("SELECT id FROM parents WHERE user_id = $1", [susanUserId]);
    const parentId = parentResult.rows[0]?.id;

    if (!parentId) {
      console.log("Susan has no parents row — skipping DB-backed tests.");
    } else {
      const createdDocumentIds: string[] = [];

      async function insertDraftDocument(extractedData: unknown): Promise<string> {
        const id = randomUUID();
        createdDocumentIds.push(id);
        await pool.query(
          `INSERT INTO documents
             (id, parent_id, uploaded_by, document_name, document_type, storage_key, mime_type, file_size_bytes, extracted_data, status)
           VALUES ($1, $2, $3, 'ZZTEST document.png', 'prescription', $4, 'image/png', 100, $5, 'needs_confirmation')`,
          [id, parentId, susanUserId, `unstored:${randomUUID()}`, JSON.stringify(extractedData)],
        );
        return id;
      }

      async function cleanup() {
        await pool.query(`DELETE FROM medications WHERE parent_id = $1 AND drug_name LIKE 'ZZTEST%'`, [parentId]);
        await pool.query(`DELETE FROM appointments WHERE parent_id = $1 AND title LIKE 'ZZTEST%'`, [parentId]);
        if (createdDocumentIds.length > 0) {
          await pool.query(`DELETE FROM documents WHERE id = ANY($1::text[])`, [createdDocumentIds]);
        }
        createdDocumentIds.length = 0;
      }

      try {
        await asyncTest("2: confirming a valid draft applies it to the medications table", async () => {
          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          const documentId = await insertDraftDocument(draft);

          const result = await confirmDocument({ documentId, userId: susanUserId, editedData: draft });
          assert.equal(result.status, "confirmed");
          assert.equal(result.hasChanges, true);

          const row = await pool.query(
            "SELECT status FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Amoxicillin'",
            [parentId],
          );
          assert.equal(row.rows.length, 1);
          assert.equal(row.rows[0].status, "active");

          const docRow = await pool.query("SELECT status, reviewed_by, reviewed_at FROM documents WHERE id = $1", [
            documentId,
          ]);
          assert.equal(docRow.rows[0].status, "confirmed");
          assert.equal(docRow.rows[0].reviewed_by, susanUserId);
          assert.ok(docRow.rows[0].reviewed_at);
        });
        await cleanup();

        await asyncTest("3: a user-edited correction (not the original draft) is what gets applied", async () => {
          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "250 mg", frequency: "once daily", status: "started" }],
          });
          const documentId = await insertDraftDocument(draft);

          const corrected = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          await confirmDocument({ documentId, userId: susanUserId, editedData: corrected });

          const row = await pool.query(
            "SELECT strength, dose_instructions FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Amoxicillin'",
            [parentId],
          );
          assert.equal(row.rows[0].strength, "500 mg");
          assert.equal(row.rows[0].dose_instructions, "twice daily");
        });
        await cleanup();

        await asyncTest("4: removing an extracted item before confirming keeps it out of care state", async () => {
          const draft = emptyDoc({
            medications: [
              { name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" },
              { name: "ZZTEST Ibuprofen", dose: "200 mg", frequency: "as needed", status: "started" },
            ],
          });
          const documentId = await insertDraftDocument(draft);

          // User removed Ibuprofen in the review screen before confirming.
          const edited = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          await confirmDocument({ documentId, userId: susanUserId, editedData: edited });

          const row = await pool.query(
            "SELECT drug_name FROM medications WHERE parent_id = $1 AND drug_name LIKE 'ZZTEST%'",
            [parentId],
          );
          assert.deepEqual(
            row.rows.map((r) => r.drug_name),
            ["ZZTEST Amoxicillin"],
          );
        });
        await cleanup();

        await asyncTest("5: confirming the same document twice does not duplicate care-state records", async () => {
          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          const documentId = await insertDraftDocument(draft);

          const first = await confirmDocument({ documentId, userId: susanUserId, editedData: draft });
          const second = await confirmDocument({ documentId, userId: susanUserId, editedData: draft });

          assert.equal(first.status, "confirmed");
          assert.equal(second.status, "already_confirmed");

          const row = await pool.query(
            "SELECT id FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Amoxicillin'",
            [parentId],
          );
          assert.equal(row.rows.length, 1);
        });
        await cleanup();

        await asyncTest("6: never calling confirm leaves care state untouched", async () => {
          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          await insertDraftDocument(draft);

          const row = await pool.query(
            "SELECT id FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Amoxicillin'",
            [parentId],
          );
          assert.equal(row.rows.length, 0);
        });
        await cleanup();

        await asyncTest("7: an invalid edited payload is rejected and nothing is written", async () => {
          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          const documentId = await insertDraftDocument(draft);

          await assert.rejects(
            () => confirmDocument({ documentId, userId: susanUserId, editedData: { medications: "not-an-array" } }),
            DocumentValidationError,
          );

          const docRow = await pool.query("SELECT status FROM documents WHERE id = $1", [documentId]);
          assert.equal(docRow.rows[0].status, "needs_confirmation");
        });
        await cleanup();

        await asyncTest("8: an unrelated active medication is not implicitly stopped by omission", async () => {
          const untouchedId = randomUUID();
          await pool.query(
            `INSERT INTO medications (id, parent_id, drug_name, strength, dose_instructions, status, confirmed_by, confirmed_at)
             VALUES ($1, $2, 'ZZTEST Untouched Med', '5 mg', 'once daily', 'active', $3, now())`,
            [untouchedId, parentId, susanUserId],
          );

          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
          });
          const documentId = await insertDraftDocument(draft);
          await confirmDocument({ documentId, userId: susanUserId, editedData: draft });

          const row = await pool.query("SELECT status FROM medications WHERE id = $1", [untouchedId]);
          assert.equal(row.rows[0].status, "active");
        });
        await cleanup();

        await asyncTest("9: an explicit dose change supersedes the old row and links provenance", async () => {
          const originalId = randomUUID();
          await pool.query(
            `INSERT INTO medications (id, parent_id, drug_name, strength, dose_instructions, status, confirmed_by, confirmed_at)
             VALUES ($1, $2, 'ZZTEST Lisinopril', '5 mg', 'once daily', 'active', $3, now())`,
            [originalId, parentId, susanUserId],
          );

          const draft = emptyDoc({
            medications: [{ name: "ZZTEST Lisinopril", dose: "10 mg", frequency: "once daily", status: "changed" }],
          });
          const documentId = await insertDraftDocument(draft);
          await confirmDocument({ documentId, userId: susanUserId, editedData: draft });

          const rows = await pool.query(
            "SELECT id, strength, status, replaces_medication_id FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Lisinopril' ORDER BY created_at ASC",
            [parentId],
          );
          assert.equal(rows.rows.length, 2);
          assert.equal(rows.rows[0].id, originalId);
          assert.equal(rows.rows[0].status, "completed");
          assert.equal(rows.rows[1].strength, "10 mg");
          assert.equal(rows.rows[1].status, "active");
          assert.equal(rows.rows[1].replaces_medication_id, originalId);

          const active = await pool.query(
            "SELECT strength FROM medications WHERE parent_id = $1 AND drug_name = 'ZZTEST Lisinopril' AND status = 'active'",
            [parentId],
          );
          assert.equal(active.rows.length, 1);
          assert.equal(active.rows[0].strength, "10 mg");
        });
        await cleanup();

        await asyncTest("11: a document describing an already-confirmed appointment does not duplicate it", async () => {
          const startsAt = new Date("2026-11-05T15:30:00Z");
          const timeZone = "America/Chicago";
          const existingApptId = randomUUID();
          await pool.query(
            `INSERT INTO appointments (id, parent_id, title, starts_at, timezone, provider_name, location, status, created_by)
             VALUES ($1, $2, 'ZZTEST Cardiology Check', $3, $4, 'Dr. Test', 'ZZTEST Clinic', 'confirmed', $5)`,
            [existingApptId, parentId, startsAt.toISOString(), timeZone, susanUserId],
          );

          // Described the same way loadPreviousCareState would format the stored row —
          // this is exactly the format-consistency the appointment-dedup fix depends on.
          const draft = emptyDoc({
            appointments: [
              {
                type: "ZZTEST Cardiology Check",
                provider: "Dr. Test",
                date: startsAt.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "long", day: "numeric" }),
                time: startsAt.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }),
                location: "ZZTEST Clinic",
              },
            ],
          });
          const documentId = await insertDraftDocument(draft);
          await confirmDocument({ documentId, userId: susanUserId, editedData: draft });

          const rows = await pool.query(
            "SELECT id FROM appointments WHERE parent_id = $1 AND title = 'ZZTEST Cardiology Check'",
            [parentId],
          );
          assert.equal(rows.rows.length, 1, "the already-confirmed appointment must not be duplicated");
        });
        await cleanup();

        await asyncTest("12: an appointment with an unparseable date is skipped, not guessed, and is surfaced for review", async () => {
          const draft = emptyDoc({
            appointments: [
              { type: "ZZTEST Mystery Visit", provider: null, date: "sometime next month", time: null, location: null },
            ],
          });
          const documentId = await insertDraftDocument(draft);
          const result = await confirmDocument({ documentId, userId: susanUserId, editedData: draft });

          const rows = await pool.query(
            "SELECT id FROM appointments WHERE parent_id = $1 AND title = 'ZZTEST Mystery Visit'",
            [parentId],
          );
          assert.equal(rows.rows.length, 0, "an unparseable appointment must not be inserted with a guessed date");
          assert.ok(result.summary.some((change) => change.type === "appointment_needs_review"));
        });
        await cleanup();

        await asyncTest("invalid or incomplete appointment times never reach persistence", async () => {
          for (const [date, time] of [["October 14, 2026", "25:90"], ["February 30, 2026", "10:30 AM"], ["October 14", "10:30 AM"], ["2026-10-14", null]]) {
            const draft = emptyDoc({ appointments: [{ type: "ZZTEST Invalid Time", provider: null, date, time, location: null }] });
            const documentId = await insertDraftDocument(draft);
            const result = await confirmDocument({ documentId, userId: susanUserId, editedData: draft });
            assert.ok(result.summary.some((change) => change.type === "appointment_needs_review"));
            assert.ok(!result.summary.some((change) => change.type === "appointment_added"));
          }
          const rows = await pool.query("SELECT id FROM appointments WHERE parent_id = $1 AND title = 'ZZTEST Invalid Time'", [parentId]);
          assert.equal(rows.rows.length, 0);
        });
        await cleanup();

        if (otherUser.rows.length > 0) {
          await asyncTest("10: an unrelated user cannot confirm another parent's document", async () => {
            const draft = emptyDoc({
              medications: [{ name: "ZZTEST Amoxicillin", dose: "500 mg", frequency: "twice daily", status: "started" }],
            });
            const documentId = await insertDraftDocument(draft);

            await assert.rejects(
              () => confirmDocument({ documentId, userId: otherUser.rows[0].id, editedData: draft }),
              DocumentAccessError,
            );

            const docRow = await pool.query("SELECT status FROM documents WHERE id = $1", [documentId]);
            assert.equal(docRow.rows[0].status, "needs_confirmation");
          });
          await cleanup();
        } else {
          console.log("test@gmail.com not found — skipping unauthorized-confirm test.");
        }
      } finally {
        await cleanup();
      }
    }
  }

  await pool.end();

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All document-confirmation tests passed.");
  }
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
