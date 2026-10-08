import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "./app.js";
import { getPool } from "./db.js";
import { buildReviewNotes, confirmDocument, parseAppointmentDateTime } from "./services/documentConfirmation.js";
import { findDocumentByContent, getLatestChanges, listParentDocuments, saveDocumentExtraction } from "./services/documentHistory.js";
import { classifyFailure, GeminiExtractionError, parseGeminiResponse } from "./services/gemini.js";
import { listSharedDocuments } from "./services/caregiverDocuments.js";
import { MAX_UPLOAD_BYTES, validateUpload } from "./services/uploadValidation.js";
import type { NormalizedDocument } from "./types.js";

// Document pipeline, end to end below the AI: upload validation and failure handling, the
// unconfirmed-draft invariant, parent review/edit/confirm, medication reconciliation,
// appointments, What Changed, duplicates/idempotency, persistence, and who may see what.
//
// Runs against the real database with temporary parents/users that are always removed.
// Gemini is NOT called (the live path is covered by testDocumentPipelineLive.mjs); RxNorm is stubbed.
// Run: npm run test-document-pipeline   (needs backend/.env for the database)

const pool = getPool();
const realFetch = globalThis.fetch;
const tag = randomUUID().slice(0, 8);

interface Actors { parentUser: string; parentId: string; cg: string; other: string; pending: string; revoked: string; parent2User: string; parent2Id: string }
const A: Actors = { parentUser: randomUUID(), parentId: randomUUID(), cg: randomUUID(), other: randomUUID(), pending: randomUUID(), revoked: randomUUID(), parent2User: randomUUID(), parent2Id: randomUUID() };
let server: Server;
let base = "";

const post = async (path: string, body: unknown) => {
  const r = await realFetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const get = async (path: string) => {
  const r = await realFetch(base + path);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
async function upload(name: string, bytes: Buffer, userId: string | null = A.parentUser) {
  const form = new FormData();
  if (userId) form.append("userId", userId);
  form.append("document", new Blob([new Uint8Array(bytes)]), name);
  const r = await realFetch(base + "/api/documents", { method: "POST", body: form });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

// RxNorm stub: every spelling of lisinopril resolves to one concept; other names to none.
function stubRxNorm() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.includes("rxnav.nlm.nih.gov")) return realFetch(input, init);
    if (url.includes("/rxcui.json")) {
      const name = decodeURIComponent(url.split("name=")[1] ?? "").toLowerCase().trim();
      const id = /^lisinopr/.test(name) ? "29046" : null;
      return new Response(JSON.stringify({ idGroup: id ? { rxnormId: [id] } : {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ properties: { name: "lisinopril" } }), { status: 200 });
  }) as typeof fetch;
}

const doc = (over: Partial<NormalizedDocument> = {}): NormalizedDocument => ({
  documentType: "after_visit_summary", medications: [], appointments: [], followUps: [], instructions: [], ...over,
});
const med = (name: string, dose: string | null, status: NormalizedDocument["medications"][number]["status"], frequency: string | null = "once daily") =>
  ({ name, dose, frequency, status, rxnorm: { rxcui: null, normalizedName: null } });
const plain = (d: NormalizedDocument) => ({ ...d, medications: d.medications.map(({ name, dose, frequency, status }) => ({ name, dose, frequency, status })) });

async function newDraft(extracted: NormalizedDocument, parentId = A.parentId, userId = A.parentUser) {
  const saved = await saveDocumentExtraction({ parentId, uploadedBy: userId, documentName: `synthetic-${tag}.pdf`, mimeType: "application/pdf", fileSizeBytes: 10, contentHash: randomUUID().replace(/-/g, ""), extractedData: extracted });
  return saved.id;
}
const seedMed = (name: string, strength: string, rxcui: string | null = null) =>
  pool.query(`INSERT INTO medications (id,parent_id,drug_name,strength,dose_instructions,rxnorm_code,status,confirmed_by,confirmed_at) VALUES ($1,$2,$3,$4,'Once daily',$5,'active',$6,now())`, [randomUUID(), A.parentId, name, strength, rxcui, A.parentUser]);
const meds = async () => (await pool.query(`SELECT drug_name, strength, status FROM medications WHERE parent_id=$1 ORDER BY created_at`, [A.parentId])).rows as { drug_name: string; strength: string; status: string }[];
const activeMeds = async () => (await meds()).filter((m) => m.status === "active");
const appts = async () => (await pool.query(`SELECT id, title, starts_at, status FROM appointments WHERE parent_id=$1`, [A.parentId])).rows;
const docCount = async (parentId = A.parentId) => Number((await pool.query(`SELECT count(*) FROM documents WHERE parent_id=$1`, [parentId])).rows[0].count);
const resetCareRecord = async () => {
  await pool.query(`UPDATE medications SET replaces_medication_id=NULL WHERE parent_id=$1`, [A.parentId]);
  await pool.query(`DELETE FROM medications WHERE parent_id=$1`, [A.parentId]);
  await pool.query(`DELETE FROM appointments WHERE parent_id=$1`, [A.parentId]);
  await pool.query(`DELETE FROM documents WHERE parent_id=$1`, [A.parentId]);
};

test("document pipeline", async (t) => {
  stubRxNorm();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mkUser = (id: string, label: string) => pool.query(`INSERT INTO users (id, full_name, email, password_hash) VALUES ($1,$2,$3,'x-not-a-real-hash')`, [id, `Temp Pipeline ${label} ${tag}`, `tmp-${id}@example.invalid`]);
  for (const [id, label] of [[A.parentUser, "Parent"], [A.cg, "Caregiver"], [A.other, "Unrelated"], [A.pending, "Pending"], [A.revoked, "Revoked"], [A.parent2User, "Parent2"]] as const) await mkUser(id, label);
  await pool.query(`INSERT INTO parents (id, full_name, user_id, timezone) VALUES ($1,$2,$3,'America/Chicago'), ($4,$5,$6,'America/Chicago')`, [A.parentId, `Temp Pipeline Parent ${tag}`, A.parentUser, A.parent2Id, `Temp Pipeline Parent2 ${tag}`, A.parent2User]);
  const rel = (uid: string, status: string) => pool.query(`INSERT INTO parent_relationships (parent_id,user_id,relationship,status,approved_by,approved_at) VALUES ($1,$2,'other',$3,$4,$5)`, [A.parentId, uid, status, status === "approved" ? A.parentUser : null, status === "approved" ? new Date() : null]);
  await rel(A.cg, "approved"); await rel(A.pending, "pending"); await rel(A.revoked, "revoked");

  t.after(async () => {
    globalThis.fetch = realFetch;
    server.close();
    for (const parentId of [A.parentId, A.parent2Id]) {
      await pool.query(`UPDATE medications SET replaces_medication_id=NULL WHERE parent_id=$1`, [parentId]).catch(() => undefined);
      for (let pass = 0; pass < 6; pass++) {
        const tables = (await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name='parent_id' AND table_schema='public'`)).rows.map((r) => r.table_name as string);
        let failed = 0;
        for (const name of tables) await pool.query(`DELETE FROM "${name}" WHERE parent_id=$1`, [parentId]).catch(() => { failed += 1; });
        if (!failed) break;
      }
      await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]).catch(() => undefined);
    }
    for (const id of [A.parentUser, A.cg, A.other, A.pending, A.revoked, A.parent2User]) await pool.query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => undefined);
    await pool.end();
  });

  // ------------------------------------------------------------------ upload validation
  await t.test("validateUpload: real PDF/PNG/JPEG pass; wrong type, empty, oversized, mislabeled bytes are rejected with distinct codes", () => {
    const pdf = Buffer.from("%PDF-1.4\n...");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    assert.equal(validateUpload("a.pdf", pdf).mediaType, "application/pdf");
    assert.equal(validateUpload("A.PNG", png).mediaType, "image/png");
    assert.equal(validateUpload("a.jpeg", jpg).mediaType, "image/jpeg");
    const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } return null; };
    assert.equal(code(() => validateUpload("a.docx", Buffer.from("PK"))), "unsupported_type");
    assert.equal(code(() => validateUpload("a.txt", Buffer.from("hello"))), "unsupported_type");
    assert.equal(code(() => validateUpload("a.json", Buffer.from("{}"))), "unsupported_type");
    assert.equal(code(() => validateUpload("a.pdf", Buffer.alloc(0))), "empty_file");
    assert.equal(code(() => validateUpload("a.pdf", Buffer.alloc(MAX_UPLOAD_BYTES + 1))), "file_too_large");
    assert.equal(code(() => validateUpload("fake.pdf", Buffer.from("this is not a pdf"))), "unreadable_file");
    assert.equal(code(() => validateUpload("photo.png", jpg)), "unreadable_file");
  });

  await t.test("upload route: every rejection is a distinct, parent-safe error and creates nothing", async () => {
    const before = await docCount();
    const cases: Array<[string, Buffer, number, string]> = [
      ["note.docx", Buffer.from("PK\u0003\u0004"), 415, "unsupported_type"],
      ["note.txt", Buffer.from("hello"), 415, "unsupported_type"],
      ["fake.pdf", Buffer.from("not really a pdf"), 422, "unreadable_file"],
      ["empty.pdf", Buffer.alloc(0), 400, "empty_file"],
      ["huge.pdf", Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(MAX_UPLOAD_BYTES + 1024)]), 413, "file_too_large"],
    ];
    for (const [name, bytes, status, code] of cases) {
      const r = await upload(name, bytes);
      assert.equal(r.status, status, name);
      assert.equal(r.body.code, code, name);
      assert.equal(typeof r.body.error, "string");
      assert.doesNotMatch(r.body.error, /stack|GEMINI|api key|node_modules|ECONN/i);
    }
    const noFile = await realFetch(base + "/api/documents", { method: "POST", body: (() => { const f = new FormData(); f.append("userId", A.parentUser); return f; })() });
    assert.equal(noFile.status, 400);
    assert.equal(((await noFile.json()) as any).code, "no_file");
    assert.equal(await docCount(), before, "a rejected upload must not create a document row");
  });

  await t.test("AI not configured: a valid file gets ai_not_configured (503), no row, and no key/config detail leaks", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const before = await docCount();
      const r = await upload("ok.pdf", Buffer.from("%PDF-1.4\n% synthetic"));
      assert.equal(r.status, 503);
      assert.equal(r.body.code, "ai_not_configured");
      assert.doesNotMatch(JSON.stringify(r.body), /GEMINI|key/i);
      assert.equal(await docCount(), before);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  await t.test("Gemini failures are classified: malformed output, bad key/model, bad input, outage", () => {
    assert.throws(() => parseGeminiResponse("not json"), (e: any) => e instanceof GeminiExtractionError && e.kind === "bad_output");
    assert.throws(() => parseGeminiResponse(undefined), (e: any) => e instanceof GeminiExtractionError && e.kind === "bad_output");
    assert.throws(() => parseGeminiResponse(JSON.stringify({ documentType: "diagnosis", medications: [] })), (e: any) => e.kind === "bad_output");
    assert.equal(classifyFailure({ status: 401 }), "not_configured");
    assert.equal(classifyFailure({ status: 403 }), "not_configured");
    assert.equal(classifyFailure({ status: 404 }), "not_configured");
    assert.equal(classifyFailure({ status: 400 }), "unreadable_input");
    assert.equal(classifyFailure({ status: 503 }), "unavailable");
    assert.equal(classifyFailure({ status: 429 }), "unavailable");
    assert.equal(classifyFailure(new Error("socket hang up")), "unavailable");
  });

  // ------------------------------------------------------------------ extraction is not confirmation
  await t.test("saving an extraction creates only an unconfirmed draft; nothing in the care record changes", async () => {
    await resetCareRecord();
    await seedMed("Lisinopril", "10 mg");
    const id = await newDraft(doc({ medications: [med("Lisinopril", "20 mg", "changed"), med("Aspirin", "81 mg", "started")], appointments: [{ type: "Cardiology", provider: null, date: "November 12, 2026", time: "11:00 AM", location: null }] }));
    const row = (await pool.query(`SELECT status, reviewed_data, reviewed_by, reviewed_at FROM documents WHERE id=$1`, [id])).rows[0];
    assert.equal(row.status, "needs_confirmation");
    assert.equal(row.reviewed_data, null);
    assert.equal(row.reviewed_by, null);
    assert.deepEqual((await meds()).map((m) => `${m.drug_name} ${m.strength} ${m.status}`), ["Lisinopril 10 mg active"]);
    assert.equal((await appts()).length, 0);
    const latest = await getLatestChanges(A.parentId);
    assert.equal(latest.changes.length, 0, "an unconfirmed draft must never produce a What Changed item");
  });

  // ------------------------------------------------------------------ caregiver leak
  await t.test("caregiver API: raw AI extraction is never returned for an unconfirmed document", async () => {
    await resetCareRecord();
    const id = await newDraft(doc({ medications: [med("Zolpidem", "5 mg", "started")] }));
    const shared = await listSharedDocuments([A.parentId]);
    const mine = shared.find((d) => d.id === id)!;
    assert.equal(mine.status, "needs_confirmation");
    assert.equal(mine.extractedData, null);
    assert.doesNotMatch(JSON.stringify(shared.filter((d) => d.parentId === A.parentId)), /zolpidem/i);
    const http = await get(`/api/caregiver/documents?userId=${A.cg}`);
    assert.equal(http.status, 200);
    assert.doesNotMatch(JSON.stringify(http.body), /zolpidem/i);
  });

  await t.test("caregiver sees the parent's REVIEWED values once confirmed, never the original extraction", async () => {
    await resetCareRecord();
    const id = await newDraft(doc({ medications: [med("Aspirin", "810 mg", "started")] })); // AI misread the dose
    await confirmDocument({ documentId: id, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "started")] })) });
    const http = await get(`/api/caregiver/documents?userId=${A.cg}`);
    const mine = http.body.documents.find((d: any) => d.id === id);
    assert.equal(mine.status, "confirmed");
    assert.equal(mine.extractedData.medications[0].dose, "81 mg");
    assert.doesNotMatch(JSON.stringify(mine), /810/);
    const meds2 = await get(`/api/caregiver/medications?userId=${A.cg}&parentId=${A.parentId}`);
    assert.match(JSON.stringify(meds2.body), /81 mg/);
    assert.doesNotMatch(JSON.stringify(meds2.body), /810/);
  });

  // ------------------------------------------------------------------ medication reconciliation
  await t.test("A) a different dose is NOT applied unless the parent confirms it as a change", async () => {
    await resetCareRecord();
    await seedMed("Lisinopril", "10 mg");
    const unclear = await newDraft(doc({ medications: [med("Lisinopril", "20 mg", "active")] }));
    const notes = await buildReviewNotes(A.parentId, doc({ medications: [med("Lisinopril", "20 mg", "active")] }));
    assert.ok(notes.some((n) => n.kind === "dose_differs" && /10 mg/.test(n.message) && /20 mg/.test(n.message)), "the review should flag the differing dose");
    const r1 = await confirmDocument({ documentId: unclear, userId: A.parentUser, editedData: plain(doc({ medications: [med("Lisinopril", "20 mg", "active")] })) });
    assert.deepEqual((await activeMeds()).map((m) => m.strength), ["10 mg"], "an unclear status must not change the dose");
    assert.equal(r1.notChanged.length, 1, "the parent is told it was left as it was");
    assert.match(r1.notChanged[0].summary, /Lisinopril/);

    const explicit = await newDraft(doc({ medications: [med("Lisinopril", "20 mg", "unknown")] }));
    await confirmDocument({ documentId: explicit, userId: A.parentUser, editedData: plain(doc({ medications: [med("Lisinopril", "20 mg", "changed")] })) });
    assert.deepEqual((await activeMeds()).map((m) => m.strength), ["20 mg"]);
    assert.ok((await meds()).some((m) => m.strength === "10 mg" && m.status === "completed"), "the old row is superseded, not deleted");
  });

  await t.test("B) a medication missing from a newer document is not stopped", async () => {
    await resetCareRecord();
    await seedMed("Metformin", "500 mg");
    const id = await newDraft(doc({ medications: [med("Aspirin", "81 mg", "started")] }));
    await confirmDocument({ documentId: id, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "started")] })) });
    const m = await meds();
    assert.equal(m.find((x) => x.drug_name === "Metformin")!.status, "active");
    assert.ok(!m.some((x) => x.status === "stopped"));
  });

  await t.test("C) a new medication is only a candidate: added when the parent confirms it as started, not when merely listed", async () => {
    await resetCareRecord();
    const listed = await newDraft(doc({ medications: [med("Aspirin", "81 mg", "active")] }));
    const notes = await buildReviewNotes(A.parentId, doc({ medications: [med("Aspirin", "81 mg", "active")] }));
    assert.ok(notes.some((n) => n.kind === "not_in_record"));
    await confirmDocument({ documentId: listed, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "active")] })) });
    assert.equal((await meds()).length, 0, "appearing in a document is not the same as starting it");
    const started = await newDraft(doc({ medications: [med("Aspirin", "81 mg", "started")] }));
    await confirmDocument({ documentId: started, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "started")] })) });
    assert.deepEqual((await activeMeds()).map((m) => m.drug_name), ["Aspirin"]);
  });

  await t.test("D) RxNorm identifies the medicine across spellings but never decides active/stopped", async () => {
    await resetCareRecord();
    await seedMed("Lisinopril", "10 mg", "29046");
    // A misspelling resolves to the same concept: it is the SAME medicine (no duplicate), and 'unknown' status changes nothing.
    const sameDrug = await newDraft(doc({ medications: [med("Lisinoprill", "10 mg", "unknown")] }));
    await confirmDocument({ documentId: sameDrug, userId: A.parentUser, editedData: plain(doc({ medications: [med("Lisinoprill", "10 mg", "unknown")] })) });
    assert.equal((await meds()).length, 1);
    // Even an explicit 'started' for a recognized, already-active concept adds no duplicate row.
    const started = await newDraft(doc({ medications: [med("LISINOPRIL", "10 mg", "started")] }));
    await confirmDocument({ documentId: started, userId: A.parentUser, editedData: plain(doc({ medications: [med("LISINOPRIL", "10 mg", "started")] })) });
    assert.equal((await meds()).length, 1);
    assert.equal((await activeMeds())[0].status, "active");
  });

  // ------------------------------------------------------------------ appointments
  await t.test("appointments: only explicit date+time enter the schedule; vague follow-ups never become dates", async () => {
    await resetCareRecord();
    assert.equal(parseAppointmentDateTime("next month", null), null);
    assert.equal(parseAppointmentDateTime("November 12, 2026", null), null);
    assert.equal(parseAppointmentDateTime(null, "11:00 AM"), null);
    assert.equal(parseAppointmentDateTime("sometime soon", "morning"), null);
    assert.ok(parseAppointmentDateTime("November 12, 2026", "11:00 AM"));
    const extracted = doc({
      appointments: [
        { type: "Cardiology", provider: "Dr. Sample", date: "November 12, 2026", time: "11:00 AM", location: "Sample Clinic" },
        { type: "Physical therapy evaluation", provider: null, date: null, time: null, location: null },
        { type: "Dermatology", provider: null, date: "December 3, 2026", time: null, location: null },
      ],
      followUps: [{ description: "Follow up with primary doctor", timeframe: "next month" }],
    });
    const notes = await buildReviewNotes(A.parentId, extracted);
    assert.equal(notes.filter((n) => n.kind === "no_exact_time").length, 2);
    const id = await newDraft(extracted);
    assert.equal((await appts()).length, 0, "no appointment before confirmation");
    const result = await confirmDocument({ documentId: id, userId: A.parentUser, editedData: plain(extracted) });
    const rows = await appts();
    assert.equal(rows.length, 1, "only the appointment with an explicit date and time is created");
    assert.equal(rows[0].status, "confirmed");
    assert.equal(rows[0].title, "Cardiology");
    assert.ok(result.summary.some((s) => s.type === "appointment_needs_review"), "the incomplete ones are reported, not silently dropped");
    assert.equal((await appts()).some((a) => /next month/i.test(JSON.stringify(a))), false);
  });

  await t.test("a confirmed appointment reaches the caregiver schedule and exports to ICS and Google Calendar", async () => {
    const list = await get(`/api/caregiver/appointments?userId=${A.cg}&parentId=${A.parentId}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.appointments.length, 1);
    const apptId = list.body.appointments[0].id;
    const ics = await realFetch(`${base}/api/caregiver/calendar/appointment/${apptId}?userId=${A.cg}&format=ics`);
    assert.equal(ics.status, 200);
    assert.match(await ics.text(), /BEGIN:VEVENT[\s\S]*DTSTART/);
    const g = await realFetch(`${base}/api/caregiver/calendar/appointment/${apptId}?userId=${A.cg}&format=google`, { redirect: "manual" });
    assert.equal(g.status, 302);
    assert.match(g.headers.get("location") ?? "", /calendar\.google\.com/);
    for (const uid of [A.other, A.pending, A.revoked]) {
      assert.equal((await realFetch(`${base}/api/caregiver/calendar/appointment/${apptId}?userId=${uid}&format=ics`)).status, 403);
    }
  });

  // ------------------------------------------------------------------ parent review: edit / remove / cancel
  await t.test("parent edits and removals decide what is saved; leaving without confirming changes nothing", async () => {
    await resetCareRecord();
    const extracted = doc({ medications: [med("Aspirin", "810 mg", "started"), med("Warfarin", "5 mg", "started")], followUps: [{ description: "Wrong follow-up", timeframe: null }] });
    const id = await newDraft(extracted);
    // Leaving the review (closing the dialog) is simply not calling confirm.
    assert.equal((await meds()).length, 0);
    assert.equal((await pool.query(`SELECT status FROM documents WHERE id=$1`, [id])).rows[0].status, "needs_confirmation");
    // The parent corrects Aspirin, removes Warfarin and the follow-up, then confirms.
    const edited = plain(doc({ medications: [med("Aspirin", "81 mg", "started")] }));
    await confirmDocument({ documentId: id, userId: A.parentUser, editedData: edited });
    assert.deepEqual((await meds()).map((m) => `${m.drug_name} ${m.strength}`), ["Aspirin 81 mg"]);
    const row = (await pool.query(`SELECT reviewed_data, extracted_data FROM documents WHERE id=$1`, [id])).rows[0];
    assert.equal(row.reviewed_data.medications.length, 1);
    assert.equal(row.reviewed_data.followUps.length, 0);
    assert.equal(row.extracted_data.medications.length, 2, "the original extraction is kept for audit, separately");
  });

  // ------------------------------------------------------------------ What Changed
  await t.test("What Changed reflects the parent-corrected confirmed value, never the AI's wrong one", async () => {
    await resetCareRecord();
    await seedMed("Lisinopril", "10 mg");
    const first = await newDraft(doc({ medications: [med("Lisinopril", "10 mg", "active")] }));
    await confirmDocument({ documentId: first, userId: A.parentUser, editedData: plain(doc({ medications: [med("Lisinopril", "10 mg", "active")] })) });
    const second = await newDraft(doc({ medications: [med("Lisinopril", "200 mg", "changed")] })); // AI misread 20 mg
    const beforeConfirm = await get(`/api/caregiver/changes?userId=${A.cg}&parentId=${A.parentId}`);
    assert.doesNotMatch(JSON.stringify(beforeConfirm.body), /200|20 mg/, "nothing from the unconfirmed draft");
    await confirmDocument({ documentId: second, userId: A.parentUser, editedData: plain(doc({ medications: [med("Lisinopril", "20 mg", "changed")] })) });
    const after = await get(`/api/caregiver/changes?userId=${A.cg}&parentId=${A.parentId}`);
    assert.equal(after.body.status, "ok");
    assert.match(JSON.stringify(after.body.changes), /10 mg to 20 mg/);
    assert.doesNotMatch(JSON.stringify(after.body), /200/);
    assert.deepEqual((await activeMeds()).map((m) => m.strength), ["20 mg"]);
  });

  await t.test("What Changed tolerates older confirmed documents whose medications have no RxNorm data", async () => {
    await resetCareRecord();
    const legacy = (dose: string, status: string) => ({ documentType: "prescription", medications: [{ name: "Lisinopril", dose, frequency: "once daily", status }], appointments: [], followUps: [], instructions: [] });
    const insert = (data: unknown, ageDays: number) => pool.query(
      `INSERT INTO documents (id,parent_id,uploaded_by,document_name,document_type,storage_key,mime_type,file_size_bytes,status,extracted_data,reviewed_data,reviewed_by,reviewed_at)
       VALUES ($1,$2,$3,'legacy.pdf','prescription',$4,'application/pdf',1,'confirmed',$5,$5,$3, now() - ($6 || ' days')::interval)`,
      [randomUUID(), A.parentId, A.parentUser, `unstored:${randomUUID()}`, JSON.stringify(data), String(ageDays)]);
    await insert(legacy("10 mg", "active"), 30);
    await insert(legacy("20 mg", "changed"), 1);
    const result = await getLatestChanges(A.parentId);
    assert.equal(result.status, "ok");
    assert.match(JSON.stringify(result.changes), /10 mg to 20 mg/);
    assert.equal((await get(`/api/caregiver/changes?userId=${A.cg}&parentId=${A.parentId}`)).status, 200);
  });

  // ------------------------------------------------------------------ duplicates and idempotency
  await t.test("same file twice = one document; concurrent saves still one row; failed rows are not reused", async () => {
    await resetCareRecord();
    const hash = createHash("sha256").update(`synthetic-${tag}`).digest("hex");
    const input = { parentId: A.parentId, uploadedBy: A.parentUser, documentName: "a.pdf", mimeType: "application/pdf", fileSizeBytes: 1, contentHash: hash, extractedData: doc() };
    const first = await saveDocumentExtraction(input);
    assert.equal(first.duplicate, false);
    const settled = await Promise.all([1, 2, 3, 4, 5].map(() => saveDocumentExtraction(input)));
    assert.ok(settled.every((s) => s.id === first.id && s.duplicate), "every repeat resolves to the original");
    assert.equal(await docCount(), 1);
    assert.equal((await findDocumentByContent(A.parentId, hash))?.id, first.id);
    assert.equal(await findDocumentByContent(A.parent2Id, hash), null, "a different parent uploading the same bytes is a different document");
    const other = await saveDocumentExtraction({ ...input, contentHash: createHash("sha256").update("different").digest("hex") });
    assert.notEqual(other.id, first.id, "different content is never merged");
    await pool.query(`UPDATE documents SET status='failed' WHERE id=$1`, [first.id]);
    const retry = await saveDocumentExtraction(input);
    assert.notEqual(retry.id, first.id, "a failed read does not block a fresh attempt");
  });

  await t.test("HTTP re-upload of a draft returns the same document and review without a second row", async () => {
    await resetCareRecord();
    const bytes = Buffer.from(`%PDF-1.4\n% synthetic ${tag}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const saved = await saveDocumentExtraction({ parentId: A.parentId, uploadedBy: A.parentUser, documentName: "dup.pdf", mimeType: "application/pdf", fileSizeBytes: bytes.length, contentHash: hash, extractedData: doc({ medications: [med("Aspirin", "81 mg", "started")] }) });
    const saved2 = await upload("dup-again.pdf", bytes); // no Gemini key needed: the existing document short-circuits the read
    assert.equal(saved2.status, 200);
    assert.equal(saved2.body.documentId, saved.id);
    assert.equal(saved2.body.duplicate, true);
    assert.equal(saved2.body.status, "needs_confirmation");
    assert.equal(saved2.body.review.medications[0].name, "Aspirin");
    await confirmDocument({ documentId: saved.id, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "started")] })) });
    const afterConfirm = await upload("dup-again.pdf", bytes);
    assert.equal(afterConfirm.body.status, "confirmed");
    assert.equal(afterConfirm.body.review, undefined, "an already-added document is not offered for review again");
    assert.equal(await docCount(), 1);
  });

  await t.test("confirm is idempotent: repeats and concurrent confirms apply the change exactly once", async () => {
    await resetCareRecord();
    await seedMed("Lisinopril", "10 mg");
    const edited = plain(doc({ medications: [med("Lisinopril", "20 mg", "changed"), med("Aspirin", "81 mg", "started")], appointments: [{ type: "Cardiology", provider: null, date: "November 12, 2026", time: "11:00 AM", location: null }] }));
    const id = await newDraft(doc());
    const results = await Promise.all([1, 2, 3, 4].map(() => confirmDocument({ documentId: id, userId: A.parentUser, editedData: edited })));
    assert.equal(results.filter((r) => r.status === "confirmed").length, 1);
    assert.equal(results.filter((r) => r.status === "already_confirmed").length, 3);
    const again = await confirmDocument({ documentId: id, userId: A.parentUser, editedData: edited });
    assert.equal(again.status, "already_confirmed");
    assert.equal(again.summary.length, 0);
    assert.equal((await meds()).length, 3, "old Lisinopril (completed) + new Lisinopril + Aspirin, no duplicates");
    assert.equal((await appts()).length, 1);
  });

  await t.test("confirm failures are real errors: wrong owner, bad data, unknown document", async () => {
    await resetCareRecord();
    const id = await newDraft(doc());
    assert.equal((await post(`/api/documents/${id}/confirm`, { userId: A.other, editedData: plain(doc()) })).status, 404);
    assert.equal((await post(`/api/documents/${id}/confirm`, { userId: A.parent2User, editedData: plain(doc()) })).status, 404);
    const bad = await post(`/api/documents/${id}/confirm`, { userId: A.parentUser, editedData: { medications: "nope" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.status, undefined);
    assert.equal((await post(`/api/documents/${randomUUID()}/confirm`, { userId: A.parentUser, editedData: plain(doc()) })).status, 404);
    assert.equal((await post(`/api/documents/${id}/confirm`, { editedData: plain(doc()) })).status, 400);
    assert.equal((await pool.query(`SELECT status FROM documents WHERE id=$1`, [id])).rows[0].status, "needs_confirmation", "failed confirms leave the draft untouched");
  });

  // ------------------------------------------------------------------ persistence for the parent
  await t.test("parent document list persists server-side, with safe metadata only, scoped to the parent", async () => {
    await resetCareRecord();
    const draft = await newDraft(doc({ medications: [med("Aspirin", "81 mg", "started")] }));
    const confirmedId = await newDraft(doc({ medications: [med("Metformin", "500 mg", "started")] }));
    await confirmDocument({ documentId: confirmedId, userId: A.parentUser, editedData: plain(doc({ medications: [med("Metformin", "500 mg", "started")] })) });
    const list = await get(`/api/parent/documents?userId=${A.parentUser}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.documents.length, 2);
    assert.deepEqual(Object.keys(list.body.documents[0]).sort(), ["documentName", "documentType", "id", "reviewedAt", "status", "uploadedAt"]);
    assert.doesNotMatch(JSON.stringify(list.body), /aspirin|metformin/i, "no extracted or reviewed content in the list");
    assert.deepEqual((await listParentDocuments(A.parentId)).map((d) => d.status).sort(), ["confirmed", "needs_confirmation"]);
    assert.equal((await get(`/api/parent/documents?userId=${A.parent2User}`)).body.documents.length, 0);
    assert.equal((await get(`/api/parent/documents?userId=${A.other}`)).status, 404);
    assert.equal((await get(`/api/parent/documents`)).status, 400);
    // Reopen the draft later (another browser/login); a confirmed one returns no content.
    const reopen = await get(`/api/parent/documents/${draft}/review?userId=${A.parentUser}`);
    assert.equal(reopen.body.status, "needs_confirmation");
    assert.equal(reopen.body.review.medications[0].name, "Aspirin");
    const reopenConfirmed = await get(`/api/parent/documents/${confirmedId}/review?userId=${A.parentUser}`);
    assert.equal(reopenConfirmed.body.status, "confirmed");
    assert.equal(reopenConfirmed.body.review, undefined);
    assert.equal((await get(`/api/parent/documents/${draft}/review?userId=${A.parent2User}`)).status, 404);
    assert.equal((await get(`/api/parent/documents/not-a-uuid/review?userId=${A.parentUser}`)).status, 404);
  });

  // ------------------------------------------------------------------ who may see what
  await t.test("caregiver authorization is enforced server-side: approved yes; unrelated, pending, revoked, substituted parentId no", async () => {
    await resetCareRecord();
    const id = await newDraft(doc({ medications: [med("Aspirin", "81 mg", "started")] }));
    await confirmDocument({ documentId: id, userId: A.parentUser, editedData: plain(doc({ medications: [med("Aspirin", "81 mg", "started")] })) });
    const okDocs = await get(`/api/caregiver/documents?userId=${A.cg}`);
    assert.ok(okDocs.body.documents.some((d: any) => d.id === id));
    for (const route of ["medications", "appointments", "changes"]) {
      assert.equal((await get(`/api/caregiver/${route}?userId=${A.cg}&parentId=${A.parentId}`)).status, 200, route);
    }
    for (const [label, uid] of [["unrelated", A.other], ["pending", A.pending], ["revoked", A.revoked], ["another parent", A.parent2User]] as const) {
      const docs = await get(`/api/caregiver/documents?userId=${uid}&parentId=${A.parentId}`);
      assert.equal(docs.status, 200);
      assert.ok(!docs.body.documents.some((d: any) => d.parentId === A.parentId), `${label}: documents`);
      for (const route of ["medications", "appointments", "changes"]) {
        assert.equal((await get(`/api/caregiver/${route}?userId=${uid}&parentId=${A.parentId}`)).status, 403, `${label}: ${route}`);
      }
    }
    assert.equal((await get(`/api/caregiver/documents`)).status, 400);
  });
});
