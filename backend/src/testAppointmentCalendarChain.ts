import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import test from "node:test";
import vm from "node:vm";
import { Pool } from "pg";
import ts from "typescript";
import { createApp } from "./app.js";
import { getPool } from "./db.js";

const parentId = "synthetic-parent";
const parentUserId = "synthetic-parent-user";
const caregiverUserId = "synthetic-caregiver-user";
const appointmentId = "appointment-db-id-0007";
const voiceSource = await readFile(new URL("../../static/js/parent/voice.js", import.meta.url), "utf8");

// Extract the real production source nodes rather than copying handler logic into the test.
function findNode(source: string, matches: (node: ts.Node) => boolean): ts.Node {
  const file = ts.createSourceFile("voice.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (matches(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(file);
  if (found) return found;
  throw new Error("Expected production JavaScript node was not found");
}

function toolSource(name: string): string {
  const node = findNode(voiceSource, (node) =>
    ts.isPropertyAssignment(node) && node.name.getText() === name);
  assert.ok(ts.isPropertyAssignment(node));
  return "(" + node.initializer.getText() + ")";
}

interface ToolInput {
  text: string;
  appointmentId?: string;
  scheduledDate?: unknown;
  scheduledTime?: unknown;
  scheduledEndTime?: unknown;
}
interface Action {
  id: string;
  text: string;
  date: string | null;
  time: string | null;
  endTime: string | null;
}
test("offline appointment lookup, voice tools, routes, storage, rendering, and calendar chain", async (t) => {
  // This standalone test never loads .env. Seal every connection before creating a pool.
  process.env.TIMESCALE_SERVICE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/offline_test";
  process.env.DATABASE_URL = process.env.TIMESCALE_SERVICE_URL;
  t.mock.method(Pool.prototype, "connect", () => { throw new Error("Real database connections are forbidden"); });
  const stored: Array<Record<string, unknown>> = [];
  const appointments = [
    { id: appointmentId, parent_id: parentId, title: "Synthetic cardiology appointment",
      starts_at: new Date("2026-10-14T19:30:00.000Z"), timezone: "America/Chicago", location: "Synthetic clinic", clinic: null },
    { id: "other-parent-appointment", parent_id: "other-parent", title: "Unrelated synthetic appointment",
      starts_at: new Date("2026-10-15T19:30:00.000Z"), timezone: "America/Chicago", location: null, clinic: null },
  ];
  let queryCount = 0;
  let failNextInsert = false; // lets a test make the database fail once
  t.mock.method(Pool.prototype, "query", async (query: unknown, values: unknown[] = []) => {
    queryCount += 1;
    assert.equal(typeof query, "string");
    const sql = (query as string).replace(/\s+/g, " ").trim();
    let rows: Array<Record<string, unknown>>;
    if (sql === "SELECT id FROM parents WHERE user_id = $1") {
      rows = values[0] === parentUserId ? [{ id: parentId }] : [];
    } else if (sql.includes("FROM parent_relationships WHERE user_id = $1 AND status = 'approved'")) {
      rows = values[0] === caregiverUserId ? [{ parent_id: parentId }] : [];
    } else if (sql.includes("FROM appointments") && sql.includes("starts_at >= now()")) {
      assert.match(sql, /^SELECT id,/i, "The real lookup query must select the database ID");
      rows = appointments.filter((row) => row.parent_id === values[0]).slice(0, 1);
    } else if (sql === "SELECT id FROM appointments WHERE id = $1 AND parent_id = $2") {
      rows = appointments.filter((row) => row.id === values[0] && row.parent_id === values[1])
        .map((row) => ({ id: row.id }));
    } else if (sql.includes("FROM caregiver_actions WHERE parent_id = $1 AND elevenlabs_conversation_id = $2")) {
      // Repeat-request lookup: same parent, same conversation, same words (case/space-insensitive), still open.
      const [parent, conversation, words] = values as string[];
      const norm = (value: unknown) => String(value).trim().toLowerCase();
      rows = stored.filter((row) => row.parent_id === parent && row.elevenlabs_conversation_id === conversation
        && row.status === "open" && norm(row.action_text) === norm(words))
        .map((row) => ({ id: row.id, action_text: row.action_text, status: row.status, appointment_id: row.appointment_id ?? null, scheduled_date: row.scheduled_date ?? null }));
    } else if (sql.startsWith("INSERT INTO caregiver_actions")) {
      if (failNextInsert) { failNextInsert = false; throw new Error("synthetic database outage"); }
      const columns = sql.match(/INSERT INTO caregiver_actions \(([^)]+)\)/)?.[1].split(",").map((column) => column.trim());
      assert.ok(columns);
      assert.equal(columns.length, values.length);
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      row.id = "synthetic-action-" + (stored.length + 1);
      row.status = "open";
      stored.push(row);
      rows = [{ id: row.id, action_text: row.action_text, status: row.status, appointment_id: row.appointment_id ?? null, scheduled_date: row.scheduled_date ?? null }];
    } else if (sql === "SELECT full_name FROM parents WHERE id = $1") {
      rows = [{ full_name: "Synthetic Parent" }];
    } else if (sql.includes("FROM caregiver_actions ca") && sql.includes("WHERE ca.id = $1")) {
      // Calendar export of ONE stored action (structured columns only).
      const row = stored.find((candidate) => candidate.id === values[0]);
      const appointment = appointments.find((candidate) => candidate.id === row?.appointment_id);
      rows = row ? [{
        id: row.id, parent_id: row.parent_id, action_text: row.action_text, appointment_id: row.appointment_id ?? null,
        scheduled_date: row.scheduled_date ?? null, scheduled_time: row.scheduled_time ?? null, scheduled_end_time: row.scheduled_end_time ?? null,
        starts_at: appointment?.starts_at ?? null, timezone: appointment?.timezone ?? null,
        appt_title: appointment?.title ?? null, appt_location: appointment?.location ?? null, clinic: appointment?.clinic ?? null,
      }] : [];
    } else if (sql.includes("FROM caregiver_actions ca")) {
      assert.match(sql, /LEFT JOIN appointments a ON a.id = ca.appointment_id/);
      assert.match(sql, /WHERE ca.parent_id = ANY\(\$1::text\[\]\)/);
      assert.ok(Array.isArray(values[0]));
      const allowedParents = values[0] as unknown[];
      rows = stored.filter((row) => allowedParents.includes(row.parent_id)).map((row) => {
        const appointment = appointments.find((appointment) => appointment.id === row.appointment_id);
        return {
          ...row, source: "voice", parent_name: "Synthetic Parent",
          created_at: new Date("2026-09-27T12:00:00Z"), completed_at: null,
          appt_starts_at: appointment?.starts_at ?? null, appt_timezone: appointment?.timezone ?? null,
          // pg parses PostgreSQL DATE values at local midnight.
          scheduled_date: typeof row.scheduled_date === "string" ? new Date(row.scheduled_date + "T00:00:00") : null,
        };
      });
    } else {
      throw new Error("Unexpected SQL in offline test");
    }
    return { rows, rowCount: rows.length };
  });

  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External service calls are forbidden"); });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = createApp().listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    const posted: Array<Record<string, unknown>> = [];
    const postedStatuses: number[] = [];
    const fetchBrowser: typeof fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const requested = new URL(input as string, origin);
      assert.equal(requested.origin, origin, "Browser requests must stay on the current origin");
      assert.ok([
        "/api/parent/next-appointment", "/api/parent/caregiver-actions", "/api/caregiver/actions",
      ].includes(requested.pathname) || requested.pathname.startsWith("/api/caregiver/calendar/"),
      "Only the tested local routes may be requested");
      if (init?.method === "POST") {
        assert.equal(typeof init.body, "string");
        posted.push(JSON.parse(init.body as string) as Record<string, unknown>);
      }
      const response = await localFetch(origin + requested.pathname + requested.search, { ...init, redirect: "manual" });
      if (init?.method === "POST") postedStatuses.push(response.status);
      return response;
    };
    const toolContext = vm.createContext({ user: { id: parentUserId }, activeConversationId: null, fetch: fetchBrowser, sentRequests: new Map() });
    // The real helper declarations from voice.js, so the tests exercise production code, not a copy.
    vm.runInContext(findNode(voiceSource, (node) => ts.isVariableStatement(node)
      && node.declarationList.declarations[0].name.getText() === "NOT_PROVIDED").getText(), toolContext);
    for (const name of ["omitPlaceholder", "requestFailureMessage"]) {
      vm.runInContext(findNode(voiceSource, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(), toolContext);
    }
    const getNext = vm.runInContext(toolSource("get_next_appointment"), toolContext) as
      () => Promise<{ status: string; appointment: { id: string } }>;
    interface ToolResult { status: string; message?: string; actionId?: string; duplicate?: boolean; scheduled?: boolean; appointmentLinked?: boolean }
    const createAction = vm.runInContext(toolSource("create_caregiver_action"), toolContext) as
      (input: ToolInput) => Promise<ToolResult>;
    async function readRenderedAction(): Promise<{ action: Action }> {
      const response = await fetchBrowser("/api/caregiver/actions?userId=" + caregiverUserId);
      assert.equal(response.status, 200);
      const body = await response.json() as { actions: Action[] };
      assert.equal(body.actions.length, 1);
      return { action: body.actions[0] };
    }
    // Exports the stored action through the real route: the record, not the page, is the source.
    async function exportedUrl(action: Action): Promise<URL> {
      const response = await fetchBrowser(`/api/caregiver/calendar/action/${action.id}?userId=${caregiverUserId}&format=google`);
      assert.equal(response.status, 302);
      const destination = response.headers.get("location");
      assert.ok(destination);
      await response.text();
      return new URL(destination);
    }
    async function exportStatus(action: Action): Promise<number> {
      const response = await fetchBrowser(`/api/caregiver/calendar/action/${action.id}?userId=${caregiverUserId}&format=google`);
      await response.text();
      return response.status;
    }

    await t.test("exact database ID reaches ownership verification; appointment time overrides conflicting schedule fields", async () => {
      stored.length = 0;
      const lookup = await getNext();
      assert.equal(lookup.status, "ok");
      assert.equal(lookup.appointment.id, appointmentId);
      assert.equal((await createAction({
        text: "Please help with my appointment; prose mentions 2031-01-01 at 09:00",
        appointmentId: lookup.appointment.id,
        scheduledDate: "2031-01-01", scheduledTime: "09:00", scheduledEndTime: "09:45",
      })).status, "ok");
      assert.equal(posted.at(-1)?.appointmentId, appointmentId);
      assert.equal(stored[0].appointment_id, appointmentId);
      const { action } = await readRenderedAction();
      assert.equal(action.date, "2026-10-14");
      assert.equal(action.time, "2:30 PM");
      assert.equal(action.endTime, null);
      const url = await exportedUrl(action);
      assert.equal(url.origin, "https://calendar.google.com");
      // The appointment is an absolute instant (19:30 UTC = 2:30 PM in Chicago), exported in UTC with the 30-minute default.
      assert.equal(url.searchParams.get("dates"), "20261014T193000Z/20261014T200000Z");
      assert.equal(url.searchParams.get("ctz"), null);
      assert.equal(url.searchParams.get("text"), "Please help with my appointment; prose mentions 2031-01-01 at 09:00");
      assert.equal(url.searchParams.get("location"), "Synthetic clinic");
    });

    for (const [label, invalidId] of [
      ["missing", undefined], ["empty", ""], ["nonexistent", "nonexistent-appointment"], ["cross-parent", "other-parent-appointment"],
    ] as const) {
      await t.test(label + " appointment ID cannot manufacture scheduling from action text", async () => {
        stored.length = 0;
        assert.equal((await createAction({
          text: "Please help on October 14, 2026 at 2:30 PM",
          appointmentId: invalidId,
        })).status, "ok");
        assert.equal(stored[0].appointment_id, null);
        const { action } = await readRenderedAction();
        assert.equal(action.date, null);
        assert.equal(action.time, null);
        assert.equal(action.endTime, null);
        // No structured date: the server refuses to export instead of guessing one from the text.
        assert.equal(await exportStatus(action), 422);
      });
    }

    await t.test("actual browser tool preserves invalid JSON types for HTTP rejection while keeping null optional", async () => {
      stored.length = 0;
      for (const field of ["scheduledDate", "scheduledTime", "scheduledEndTime"]) {
        for (const value of [0, false, {}, []]) {
          const queriesBefore = queryCount;
          const postsBefore = posted.length;
          const result = await createAction({ text: "Synthetic malformed tool input", [field]: value });
          assert.equal(posted.length, postsBefore + 1, "The actual tool must send the request");
          assert.deepEqual(posted.at(-1)?.[field], value, "Invalid JSON types must not be silently discarded");
          assert.equal(postedStatuses.at(-1), 400);
          assert.equal(result.status, "error");
          assert.equal(queryCount, queriesBefore, "Malformed tool parameters must not reach the database");
          assert.equal(stored.length, 0);
        }
      }
      const result = await createAction({ text: "Synthetic optional tool input",
        scheduledDate: null, scheduledTime: null, scheduledEndTime: null });
      assert.equal(result.status, "ok");
      assert.equal(postedStatuses.at(-1), 201);
      assert.deepEqual([stored[0].scheduled_date, stored[0].scheduled_time, stored[0].scheduled_end_time], [null, null, null]);
    });

    await t.test("HTTP validation rejects malformed scheduling before any database access", async () => {
      const invalid: Array<Record<string, unknown>> = [];
      for (const field of ["scheduledDate", "scheduledTime", "scheduledEndTime"]) {
        for (const value of [0, false, {}, [], "", "   "]) {
          invalid.push({ [field]: value });
        }
      }
      invalid.push(
        { scheduledDate: "2026-02-30" },
        { scheduledDate: "next Friday" },
        { scheduledDate: "2026-10-14T00:00:00Z" },
        { scheduledDate: "2026-10-14", scheduledTime: "24:00" },
        { scheduledDate: "2026-10-14", scheduledTime: "10:3" },
        { scheduledDate: "2026-10-14", scheduledTime: "10:30 AM" },
        { scheduledDate: "2026-10-14", scheduledTime: "10:30", scheduledEndTime: "25:00" },
        { scheduledTime: "10:30" },
        { scheduledDate: "2026-10-14", scheduledEndTime: "11:00" },
        { scheduledDate: "2026-10-14", scheduledTime: "10:30", scheduledEndTime: "09:30" },
      );
      for (const fields of invalid) {
        const queriesBefore = queryCount;
        const response = await fetchBrowser("/api/parent/caregiver-actions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: parentUserId, text: "Synthetic reminder", ...fields }),
        });
        assert.equal(response.status, 400, JSON.stringify(fields));
        assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
        assert.equal(queryCount, queriesBefore, "Invalid scheduling must be rejected before database access");
      }
    });

    await t.test("explicit null scheduling fields and an empty appointment ID remain optional", async () => {
      stored.length = 0;
      const response = await fetchBrowser("/api/parent/caregiver-actions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: parentUserId, text: "Synthetic unscheduled request", appointmentId: "",
          scheduledDate: null, scheduledTime: null, scheduledEndTime: null }),
      });
      assert.equal(response.status, 201);
      await response.json();
      assert.equal(stored[0].appointment_id, null);
      const { action } = await readRenderedAction();
      assert.deepEqual([action.date, action.time, action.endTime], [null, null, null]);
    });

    await t.test("pg local-midnight DATE values survive a positive-offset server timezone", async () => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = "Asia/Tokyo";
      try {
        stored.length = 0;
        assert.equal((await createAction({ text: "Synthetic calendar-date reminder", scheduledDate: "2026-10-15" })).status, "ok");
        const { action } = await readRenderedAction();
        assert.equal(action.date, "2026-10-15");
        assert.equal((await exportedUrl(action)).searchParams.get("dates"), "20261015/20261016");
      } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    });

    await t.test("explicit general date survives the real chain and exports all-day without a current-time fallback", async () => {
      stored.length = 0;
      assert.equal((await createAction({ text: "Synthetic general reminder", scheduledDate: "2026-10-15" })).status, "ok");
      const { action } = await readRenderedAction();
      assert.equal(action.date, "2026-10-15");
      assert.equal(action.time, null);
      assert.equal(action.endTime, null);
      assert.equal((await exportedUrl(action)).searchParams.get("dates"), "20261015/20261016");
    });

    // ---- the real ElevenLabs agent marks every field required, so it sends "" for "not provided" ----
    await t.test("agent-style empty strings for every optional field create a real, unscheduled, unlinked request", async () => {
      stored.length = 0;
      const result = await createAction({ text: "Tell my daughter I need a ride", appointmentId: "", scheduledDate: "", scheduledTime: "", scheduledEndTime: "" } as ToolInput);
      assert.equal(result.status, "ok");
      assert.equal(postedStatuses.at(-1), 201);
      assert.deepEqual([posted.at(-1)?.appointmentId, posted.at(-1)?.scheduledDate, posted.at(-1)?.scheduledTime, posted.at(-1)?.scheduledEndTime], [null, null, null, null],
        "empty strings are sent as 'not provided', never as a date");
      assert.equal(stored.length, 1);
      assert.deepEqual([stored[0].appointment_id, stored[0].scheduled_date, stored[0].scheduled_time, stored[0].scheduled_end_time], [null, null, null, null]);
      assert.equal(stored[0].parent_id, parentId, "owned by the parent who asked");
      assert.equal(stored[0].created_by_user_id, parentUserId);
      assert.equal(stored[0].status, "open");
      assert.equal("source" in stored[0], false, "parent requests rely on the table default source ('voice' = parent-originated)");
      assert.ok(result.actionId, "the agent is told the saved action id");
      assert.equal(result.scheduled, false);
      assert.equal(result.appointmentLinked, false);
      assert.match(result.message ?? "", /saved/i);
    });

    for (const placeholder of ["none", "None", "N/A", "n/a", "null", "undefined", "unknown", "not specified", "  ", "-"]) {
      await t.test(`placeholder ${JSON.stringify(placeholder)} for schedule fields means 'not provided'`, async () => {
        stored.length = 0;
        const result = await createAction({ text: "Pick up my prescription", scheduledDate: placeholder, scheduledTime: placeholder, scheduledEndTime: placeholder } as ToolInput);
        assert.equal(result.status, "ok");
        assert.deepEqual([stored[0].scheduled_date, stored[0].scheduled_time, stored[0].scheduled_end_time], [null, null, null]);
      });
    }

    await t.test("an explicitly stated date and time still pass through exactly", async () => {
      stored.length = 0;
      const result = await createAction({ text: "Take me to the park", scheduledDate: " 2026-10-15 ", scheduledTime: "09:30", scheduledEndTime: "" } as ToolInput);
      assert.equal(result.status, "ok");
      assert.deepEqual([stored[0].scheduled_date, stored[0].scheduled_time, stored[0].scheduled_end_time], ["2026-10-15", "09:30", null]);
      assert.equal(result.scheduled, true);
    });

    await t.test("a made-up date is still rejected by the server, and the agent is told the request was NOT sent", async () => {
      stored.length = 0;
      const queriesBefore = queryCount;
      for (const bad of ["next Friday", "tomorrow", "10/15/2026", "2026-13-40"]) {
        const result = await createAction({ text: "Take me to the park", scheduledDate: bad } as ToolInput);
        assert.equal(result.status, "error", bad);
        assert.match(result.message ?? "", /NOT sent/);
        assert.match(result.message ?? "", /Do not tell the parent it was sent/);
        assert.equal(postedStatuses.at(-1), 400);
      }
      assert.equal(stored.length, 0);
      assert.equal(queryCount, queriesBefore, "rejected before the database");
    });

    await t.test("a request about a stored appointment (with empty schedule strings) keeps the appointment link", async () => {
      stored.length = 0;
      const lookup = await getNext();
      const result = await createAction({ text: "I need a ride to my appointment", appointmentId: lookup.appointment.id, scheduledDate: "", scheduledTime: "", scheduledEndTime: "" } as ToolInput);
      assert.equal(result.status, "ok");
      assert.equal(stored[0].appointment_id, appointmentId);
      assert.equal(stored[0].scheduled_date, null, "no date is copied or invented; the appointment stays authoritative");
      assert.equal(result.appointmentLinked, true);
      assert.equal(result.scheduled, true, "linked appointments make it schedulable");
    });

    await t.test("another parent's appointment id (or a placeholder id) cannot link: the request is still created, unlinked", async () => {
      for (const id of ["other-parent-appointment", "none", ""]) {
        stored.length = 0;
        const result = await createAction({ text: `Ride ${id || "blank"}`, appointmentId: id } as ToolInput);
        assert.equal(result.status, "ok");
        assert.equal(stored[0].appointment_id, null, id);
        assert.equal(result.appointmentLinked, false);
      }
    });

    await t.test("the same request twice in one conversation is stored once (sequential, concurrent, and server-side repeat)", async () => {
      stored.length = 0;
      toolContext.sentRequests.clear();
      vm.runInContext('activeConversationId = "conv-repeat-1"', toolContext);
      const postsBefore = posted.length;
      const first = await createAction({ text: "Tell my daughter I need a ride", appointmentId: "", scheduledDate: "", scheduledTime: "", scheduledEndTime: "" } as ToolInput);
      const second = await createAction({ text: "tell my daughter i need a ride", appointmentId: "", scheduledDate: "", scheduledTime: "", scheduledEndTime: "" } as ToolInput);
      assert.equal(first.status, "ok");
      assert.equal(second.status, "ok");
      assert.equal(second.duplicate, true);
      assert.equal(stored.length, 1);
      assert.equal(posted.length, postsBefore + 1, "the second call never reaches the server");

      // a second page session (fresh in-memory record) hitting the server with the same words is recognised there
      toolContext.sentRequests.clear();
      const viaServer = await createAction({ text: "TELL MY DAUGHTER I NEED A RIDE  ", appointmentId: "", scheduledDate: "", scheduledTime: "", scheduledEndTime: "" } as ToolInput);
      assert.equal(viaServer.status, "ok");
      assert.equal(viaServer.duplicate, true);
      assert.equal(postedStatuses.at(-1), 200, "a repeat is a 200, not a 201");
      assert.equal(stored.length, 1, "still exactly one row");

      // two calls at once (the agent retrying while the first is still in flight)
      stored.length = 0;
      toolContext.sentRequests.clear();
      vm.runInContext('activeConversationId = "conv-repeat-2"', toolContext);
      const postsBeforeConcurrent = posted.length;
      const [a, b] = await Promise.all([
        createAction({ text: "Pick up my prescription", appointmentId: "" } as ToolInput),
        createAction({ text: "Pick up my prescription", appointmentId: "" } as ToolInput),
      ]);
      assert.deepEqual([a.status, b.status], ["ok", "ok"]);
      assert.equal(stored.length, 1);
      assert.equal(posted.length, postsBeforeConcurrent + 1);

      // different words are a different request
      const other = await createAction({ text: "Call the pharmacy", appointmentId: "" } as ToolInput);
      assert.equal(other.status, "ok");
      assert.equal(stored.length, 2);
      vm.runInContext("activeConversationId = null", toolContext);
    });

    await t.test("when saving fails the agent is told plainly it was NOT sent, nothing is stored, and a retry can succeed", async () => {
      stored.length = 0;
      toolContext.sentRequests.clear();
      vm.runInContext('activeConversationId = "conv-failure-1"', toolContext);
      failNextInsert = true;
      const failed = await createAction({ text: "Tell my daughter I need a ride", appointmentId: "" } as ToolInput);
      assert.equal(failed.status, "error");
      assert.match(failed.message ?? "", /NOT sent/);
      assert.match(failed.message ?? "", /Do not tell the parent it was sent/);
      assert.equal(failed.actionId, undefined);
      assert.equal(postedStatuses.at(-1), 500);
      assert.equal(stored.length, 0);
      const retried = await createAction({ text: "Tell my daughter I need a ride", appointmentId: "" } as ToolInput);
      assert.equal(retried.status, "ok", "a failed attempt is not remembered as sent");
      assert.equal(stored.length, 1);
      vm.runInContext("activeConversationId = null", toolContext);
    });

    await t.test("no parent profile for the user, a network failure and a missing user all report NOT sent", async () => {
      const noParent = vm.createContext({ user: { id: "unknown-user" }, activeConversationId: null, fetch: fetchBrowser, sentRequests: new Map() });
      for (const name of ["omitPlaceholder", "requestFailureMessage"]) {
        vm.runInContext(findNode(voiceSource, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(), noParent);
      }
      vm.runInContext(findNode(voiceSource, (node) => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText() === "NOT_PROVIDED").getText(), noParent);
      const tool = vm.runInContext(toolSource("create_caregiver_action"), noParent) as (input: ToolInput) => Promise<ToolResult>;
      const result = await tool({ text: "Ride please" });
      assert.equal(result.status, "error");
      assert.match(result.message ?? "", /NOT sent/);
      assert.match(result.message ?? "", /account/);
      assert.equal(postedStatuses.at(-1), 404);

      const offline = vm.createContext({ user: { id: parentUserId }, activeConversationId: null, fetch: async () => { throw new Error("offline"); }, sentRequests: new Map() });
      for (const name of ["omitPlaceholder", "requestFailureMessage"]) {
        vm.runInContext(findNode(voiceSource, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(), offline);
      }
      vm.runInContext(findNode(voiceSource, (node) => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText() === "NOT_PROVIDED").getText(), offline);
      const offlineTool = vm.runInContext(toolSource("create_caregiver_action"), offline) as (input: ToolInput) => Promise<ToolResult>;
      const offlineResult = await offlineTool({ text: "Ride please" });
      assert.equal(offlineResult.status, "error");
      assert.match(offlineResult.message ?? "", /NOT sent/);

      const noUser = vm.createContext({ user: null, activeConversationId: null, fetch: fetchBrowser, sentRequests: new Map() });
      const noUserTool = vm.runInContext(toolSource("create_caregiver_action"), noUser) as (input: ToolInput) => Promise<ToolResult>;
      assert.match((await noUserTool({ text: "Ride please" })).message ?? "", /NOT sent/);
      assert.match((await createAction({ text: "   " })).message ?? "", /NOT sent/);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await getPool().end();
  }
});
