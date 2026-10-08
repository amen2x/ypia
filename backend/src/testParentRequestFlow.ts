import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "./app.js";

// Parent request -> approved caregiver, over the REAL routes with an in-memory stand-in for Postgres.
// Covers: creation, ownership, source, repeats, relationship visibility (approved / unrelated / pending),
// completion, scheduling the same row, and export.

const PA = "parent-a", PB = "parent-b";                 // parents.id
const UA = "user-parent-a", UB = "user-parent-b";       // their user ids
const CA = "caregiver-approved-for-a";
const CB = "caregiver-approved-for-b";
const CP = "caregiver-pending-for-a";
const CN = "caregiver-with-no-links";

interface Row {
  id: string; parent_id: string; created_by_user_id: string; action_text: string; status: string; source: string;
  elevenlabs_conversation_id: string | null; created_at: Date; completed_at: Date | null;
  appointment_id: string | null; scheduled_date: string | null; scheduled_time: string | null; scheduled_end_time: string | null;
}

test("parent request flow: creation, source, repeats, relationships, completion, scheduling, export", async (t) => {
  process.env.TIMESCALE_SERVICE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/offline_test";
  process.env.DATABASE_URL = process.env.TIMESCALE_SERVICE_URL;
  t.mock.method(Pool.prototype, "connect", () => { throw new Error("Real database connections are forbidden"); });

  const parentOfUser: Record<string, string> = { [UA]: PA, [UB]: PB };
  const names: Record<string, string> = { [PA]: "Margaret Ellis", [PB]: "Walter Reed" };
  const relationships = [
    { parent_id: PA, user_id: CA, status: "approved" },
    { parent_id: PA, user_id: CP, status: "pending" },
    { parent_id: PB, user_id: CB, status: "approved" },
  ];
  const appointments = [{ id: "appt-a", parent_id: PA, title: "Cardiology follow-up", starts_at: new Date("2026-10-14T19:30:00Z"), timezone: "America/Chicago", location: "Columbia Clinic" }];
  const actions: Row[] = [];
  let nextId = 1;

  const approvedFor = (user: unknown) => relationships.filter((r) => r.user_id === user && r.status === "approved").map((r) => r.parent_id);
  const pgDate = (value: string | null) => (value ? new Date(`${value}T00:00:00`) : null);

  t.mock.method(Pool.prototype, "query", async (query: unknown, values: unknown[] = []) => {
    const sql = String(query).replace(/\s+/g, " ").trim();
    let rows: Array<Record<string, unknown>> = [];
    if (sql === "SELECT id FROM parents WHERE user_id = $1") {
      rows = parentOfUser[values[0] as string] ? [{ id: parentOfUser[values[0] as string] }] : [];
    } else if (sql === "SELECT id FROM appointments WHERE id = $1 AND parent_id = $2") {
      rows = appointments.filter((a) => a.id === values[0] && a.parent_id === values[1]).map((a) => ({ id: a.id }));
    } else if (sql.includes("FROM caregiver_actions WHERE parent_id = $1 AND elevenlabs_conversation_id = $2")) {
      const [parent, conversation, words] = values as string[];
      rows = actions.filter((a) => a.parent_id === parent && a.elevenlabs_conversation_id === conversation && a.status === "open"
        && a.action_text.trim().toLowerCase() === words.trim().toLowerCase()) as unknown as Array<Record<string, unknown>>;
    } else if (sql.startsWith("INSERT INTO caregiver_actions")) {
      const columns = sql.match(/INSERT INTO caregiver_actions \(([^)]+)\)/)?.[1].split(",").map((c) => c.trim()) ?? [];
      const data = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
      const row: Row = {
        id: `action-${nextId++}`, parent_id: data.parent_id as string, created_by_user_id: data.created_by_user_id as string,
        action_text: data.action_text as string, status: "open", source: (data.source as string) ?? "voice", // the table default
        elevenlabs_conversation_id: (data.elevenlabs_conversation_id as string) ?? null, created_at: new Date(), completed_at: null,
        appointment_id: (data.appointment_id as string) ?? null, scheduled_date: (data.scheduled_date as string) ?? null,
        scheduled_time: (data.scheduled_time as string) ?? null, scheduled_end_time: (data.scheduled_end_time as string) ?? null,
      };
      actions.push(row);
      rows = [row as unknown as Record<string, unknown>];
    } else if (sql.includes("FROM parent_relationships WHERE user_id = $1 AND status = 'approved'")) {
      rows = approvedFor(values[0]).map((parent_id) => ({ parent_id }));
    } else if (sql.startsWith("SELECT 1 AS one FROM parent_relationships WHERE user_id = $1 AND parent_id = $2")) {
      rows = relationships.some((r) => r.user_id === values[0] && r.parent_id === values[1] && r.status === "approved") ? [{ one: 1 }] : [];
    } else if (sql.includes("FROM caregiver_actions ca JOIN parents p ON p.id = ca.parent_id") && sql.includes("WHERE ca.parent_id = ANY($1::text[])")) {
      const allowed = values[0] as string[];
      rows = actions.filter((a) => allowed.includes(a.parent_id)).sort((x, y) => Number(y.status === "open") - Number(x.status === "open") || y.created_at.getTime() - x.created_at.getTime()).map((a) => {
        const appt = appointments.find((p) => p.id === a.appointment_id);
        return { ...a, parent_name: names[a.parent_id], appt_starts_at: appt?.starts_at ?? null, appt_timezone: appt?.timezone ?? null, appt_title: appt?.title ?? null, scheduled_date: pgDate(a.scheduled_date) };
      });
    } else if (sql.startsWith("SELECT ca.id FROM caregiver_actions ca JOIN parent_relationships pr")) {
      const row = actions.find((a) => a.id === values[1]);
      rows = row && relationships.some((r) => r.parent_id === row.parent_id && r.user_id === values[0] && r.status === "approved") ? [{ id: row.id }] : [];
    } else if (sql.startsWith("UPDATE caregiver_actions SET status = $1")) {
      const row = actions.find((a) => a.id === values[1]);
      assert.ok(row);
      row.status = values[0] as string;
      row.completed_at = row.status === "done" ? new Date() : null;
      rows = [{ id: row.id, status: row.status, completed_at: row.completed_at }];
    } else if (sql.startsWith("SELECT ca.id, ca.appointment_id FROM caregiver_actions ca JOIN parent_relationships pr")) {
      const row = actions.find((a) => a.id === values[1]);
      rows = row && relationships.some((r) => r.parent_id === row.parent_id && r.user_id === values[0] && r.status === "approved") ? [{ id: row.id, appointment_id: row.appointment_id }] : [];
    } else if (sql.startsWith("UPDATE caregiver_actions SET scheduled_date = $1::date")) {
      const row = actions.find((a) => a.id === values[3]);
      assert.ok(row);
      [row.scheduled_date, row.scheduled_time, row.scheduled_end_time] = [values[0], values[1], values[2]] as Array<string | null>;
      rows = [{ id: row.id, scheduled_date: row.scheduled_date, scheduled_time: row.scheduled_time, scheduled_end_time: row.scheduled_end_time }];
    } else if (sql === "SELECT full_name FROM parents WHERE id = $1") {
      rows = [{ full_name: names[values[0] as string] }];
    } else if (sql.includes("FROM caregiver_actions ca LEFT JOIN appointments a ON a.id = ca.appointment_id") && sql.includes("WHERE ca.id = $1")) {
      const row = actions.find((a) => a.id === values[0]);
      const appt = appointments.find((p) => p.id === row?.appointment_id);
      rows = row ? [{ ...row, starts_at: appt?.starts_at ?? null, timezone: appt?.timezone ?? null, appt_title: appt?.title ?? null, appt_location: appt?.location ?? null, clinic: null }] : [];
    } else {
      throw new Error("Unexpected SQL in offline test: " + sql.slice(0, 110));
    }
    return { rows, rowCount: rows.length };
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = createApp().listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(origin + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const text = await response.text();
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* not JSON (redirects, ICS) */ }
      return { status: response.status, json, text, headers: response.headers };
    };
    const parentRequest = (userId: string, text: string, extra: Record<string, unknown> = {}) =>
      send("POST", "/api/parent/caregiver-actions", { userId, text, conversationId: null, appointmentId: null, scheduledDate: null, scheduledTime: null, scheduledEndTime: null, ...extra });
    const visibleTo = async (caregiver: string): Promise<Array<Record<string, any>>> => (await send("GET", `/api/caregiver/actions?userId=${caregiver}`)).json.actions;

    await t.test("a parent request becomes a real row: owned by the parent, parent-originated, open, unscheduled, nothing invented", async () => {
      const res = await parentRequest(UA, "I need a ride to my appointment", { conversationId: "conv-1" });
      assert.equal(res.status, 201);
      assert.equal(res.json.status, "created");
      assert.deepEqual([res.json.action.duplicate, res.json.action.scheduled, res.json.action.appointmentLinked], [false, false, false]);
      const row = actions[0];
      assert.equal(row.parent_id, PA);
      assert.equal(row.created_by_user_id, UA);
      assert.equal(row.source, "voice", "source classifies it as parent-originated");
      assert.equal(row.status, "open");
      assert.deepEqual([row.scheduled_date, row.scheduled_time, row.scheduled_end_time, row.appointment_id], [null, null, null, null]);
      assert.equal(row.action_text, "I need a ride to my appointment", "the words are stored as spoken, never parsed for a date");
    });

    await t.test("the same request repeated in the same conversation is not a second request", async () => {
      const again = await parentRequest(UA, "  i need a RIDE to my appointment ", { conversationId: "conv-1" });
      assert.equal(again.status, 200);
      assert.equal(again.json.status, "duplicate");
      assert.equal(again.json.action.id, actions[0].id);
      assert.equal(actions.length, 1);
      const elsewhere = await parentRequest(UA, "I need a ride to my appointment", { conversationId: "conv-2" });
      assert.equal(elsewhere.status, 201, "a later conversation asking again is a new request");
      assert.equal(actions.length, 2);
      actions.pop(); // keep the rest of the scenarios simple
    });

    await t.test("relationship visibility: approved caregiver yes; unrelated, other parent's, pending and unlinked caregivers no", async () => {
      await parentRequest(UB, "Please call the pharmacy", { conversationId: "conv-b" });
      const asA = await visibleTo(CA);
      assert.deepEqual(asA.map((a) => a.text), ["I need a ride to my appointment"]);
      assert.equal(asA[0].source, "voice");
      assert.equal(asA[0].parentId, PA);
      assert.equal(asA[0].parentName, "Margaret Ellis");
      assert.deepEqual((await visibleTo(CB)).map((a) => a.text), ["Please call the pharmacy"], "B sees only parent B's request");
      assert.deepEqual(await visibleTo(CP), [], "a pending link sees nothing");
      assert.deepEqual(await visibleTo(CN), [], "an unlinked caregiver sees nothing");
      const pendingExport = await send("GET", `/api/caregiver/calendar/action/${actions[0].id}?userId=${CP}&format=ics`);
      assert.equal(pendingExport.status, 403);
      const strangerExport = await send("GET", `/api/caregiver/calendar/action/${actions[0].id}?userId=${CB}&format=ics`);
      assert.equal(strangerExport.status, 403);
    });

    await t.test("approval flips visibility for that caregiver only", async () => {
      relationships.find((r) => r.user_id === CP)!.status = "approved";
      assert.equal((await visibleTo(CP)).length, 1);
      relationships.find((r) => r.user_id === CP)!.status = "pending";
      assert.equal((await visibleTo(CP)).length, 0);
    });

    await t.test("caregiver-created tasks and parent requests are both returned, distinguished by source", async () => {
      const created = await send("POST", "/api/caregiver/actions", { userId: CA, parentId: PA, text: "Book physical therapy" });
      assert.equal(created.status, 201);
      const list = await visibleTo(CA);
      assert.deepEqual(list.map((a) => [a.text, a.source]).sort(), [["Book physical therapy", "caregiver"], ["I need a ride to my appointment", "voice"]]);
      assert.equal((await send("POST", "/api/caregiver/actions", { userId: CB, parentId: PA, text: "Not allowed" })).status, 403);
      assert.equal(list.find((a) => a.source === "caregiver")?.parentId, PA);
    });

    await t.test("completing and reopening: only an approved caregiver can, and the request stays visible as done", async () => {
      const id = actions.find((a) => a.source === "voice" && a.parent_id === PA)!.id;
      assert.equal((await send("PATCH", `/api/caregiver/actions/${id}`, { userId: CB, status: "done" })).status, 404);
      assert.equal((await send("PATCH", `/api/caregiver/actions/${id}`, { userId: CP, status: "done" })).status, 404);
      assert.equal((await send("PATCH", `/api/caregiver/actions/${id}`, { userId: CA, status: "done" })).status, 200);
      const done = (await visibleTo(CA)).find((a) => a.id === id);
      assert.equal(done?.status, "done");
      assert.ok(done?.completedAt);
      assert.equal((await send("PATCH", `/api/caregiver/actions/${id}`, { userId: CA, status: "open" })).status, 200);
      assert.equal((await visibleTo(CA)).find((a) => a.id === id)?.status, "open");
    });

    await t.test("scheduling a parent request updates the SAME row, keeps it parent-originated, then it exports; exporting adds nothing", async () => {
      const row = actions.find((a) => a.source === "voice" && a.parent_id === PA)!;
      assert.equal((await send("GET", `/api/caregiver/calendar/action/${row.id}?userId=${CA}&format=google`)).status, 422);
      const count = actions.length;
      const scheduled = await send("PATCH", `/api/caregiver/actions/${row.id}/schedule`, { userId: CA, scheduledDate: "2027-03-15", scheduledTime: "09:30" });
      assert.equal(scheduled.status, 200);
      assert.equal(row.source, "voice");
      assert.equal(actions.length, count);
      const listed = (await visibleTo(CA)).find((a) => a.id === row.id);
      assert.deepEqual([listed?.date, listed?.time], ["2027-03-15", "09:30"]);
      const google = await send("GET", `/api/caregiver/calendar/action/${row.id}?userId=${CA}&format=google`);
      assert.equal(google.status, 302);
      assert.match(google.headers.get("location") ?? "", /dates=20270315T093000%2F20270315T100000/);
      for (let i = 0; i < 3; i += 1) await send("GET", `/api/caregiver/calendar/action/${row.id}?userId=${CA}&format=ics`);
      assert.equal(actions.length, count, "exports never create records");
      assert.equal((await send("PATCH", `/api/caregiver/actions/${row.id}/schedule`, { userId: CB, scheduledDate: "2027-03-16" })).status, 404, "another parent's caregiver cannot schedule it");
    });

    await t.test("a request linked to the parent's own appointment uses that appointment's time; another parent's appointment id cannot link", async () => {
      const linked = await parentRequest(UA, "Take me to my appointment", { conversationId: "conv-3", appointmentId: "appt-a" });
      assert.equal(linked.json.action.appointmentLinked, true);
      assert.equal(linked.json.action.scheduled, true);
      const item = (await visibleTo(CA)).find((a) => a.id === linked.json.action.id);
      assert.equal(item?.date, "2026-10-14");
      assert.equal(item?.appointmentTitle, "Cardiology follow-up");
      assert.equal((await send("GET", `/api/caregiver/calendar/action/${item?.id}?userId=${CA}&format=google`)).status, 302);
      assert.equal((await send("PATCH", `/api/caregiver/actions/${item?.id}/schedule`, { userId: CA, scheduledDate: "2027-01-01" })).status, 409, "the appointment stays authoritative");

      const crossed = await parentRequest(UB, "Ride to someone else's appointment", { conversationId: "conv-4", appointmentId: "appt-a" });
      assert.equal(crossed.status, 201);
      assert.equal(crossed.json.action.appointmentLinked, false);
      assert.equal(actions.find((a) => a.id === crossed.json.action.id)?.appointment_id, null);
    });

    await t.test("malformed parent requests are rejected and create nothing", async () => {
      const before = actions.length;
      assert.equal((await parentRequest(UA, "x", { scheduledDate: "" })).status, 400, "the server still refuses empty-string dates (the client normalises them)");
      assert.equal((await parentRequest(UA, "x", { scheduledDate: "next Friday" })).status, 400);
      assert.equal((await parentRequest(UA, "x", { scheduledTime: "09:30" })).status, 400);
      assert.equal((await parentRequest(UA, "")).status, 400);
      assert.equal((await parentRequest(UA, "y".repeat(501))).status, 400);
      assert.equal((await send("POST", "/api/parent/caregiver-actions", { text: "no user" })).status, 400);
      assert.equal((await parentRequest("someone-without-a-parent-profile", "Ride please")).status, 404);
      assert.equal(actions.length, before);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
