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
const parentHtml = await readFile(new URL("../../templates/parent.html", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("../../templates/index.html", import.meta.url), "utf8");

// Extract actual source nodes rather than copying production handler logic.
function findNode(html: string, matches: (node: ts.Node) => boolean): ts.Node {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const file = ts.createSourceFile("inline.js", script[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let found: ts.Node | undefined;
    function visit(node: ts.Node): void {
      if (matches(node)) found = node;
      else ts.forEachChild(node, visit);
    }
    visit(file);
    if (found) return found;
  }
  throw new Error("Expected production JavaScript node was not found");
}

function toolSource(name: string): string {
  const node = findNode(parentHtml, (node) =>
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
interface RenderedItem {
  dataset: Record<string, string>;
  innerHTML: string;
  className: string;
  draggable: boolean;
  querySelector(selector: string): { textContent: string; value: string };
}

function caregiverPage(fetchBrowser: typeof fetch) {
  const items: RenderedItem[] = [];
  const opened: string[] = [];
  const alerts: string[] = [];
  const list = {
    children: items,
    appendChild: (item: RenderedItem) => { items.push(item); },
    insertBefore: (item: RenderedItem, target: RenderedItem) => { items.splice(items.indexOf(target), 0, item); },
  };
  const document = {
    getElementById: (id: string) => items.find((item) => item.innerHTML.includes('id="' + id + '"')),
    createElement: () => {
      const item: RenderedItem = {
        // DOMStringMap stringifies assigned values, including undefined.
        dataset: new Proxy<Record<string, string>>({}, {
          set(target, key: string, value: unknown) { target[key] = String(value); return true; },
        }),
        innerHTML: "", className: "", draggable: false,
        querySelector: (selector: string) => ({
          textContent: selector === "label" ? item.innerHTML.match(/<label[^>]*>([\s\S]*?)<\/label>/)?.[1] ?? "" : "",
          value: "",
        }),
      };
      return item;
    },
  };
  const context = vm.createContext({
    document, list, fetch: fetchBrowser, caregiverUser: { id: caregiverUserId },
    CAREGIVER_API_BASE: "", totalItemCount: 0, completedItemCount: 0,
    wheelFg: null, wheelLabel: null, URLSearchParams,
    console: { error: () => { throw new Error("Unexpected caregiver load failure"); } },
    window: { open: (url: string) => { opened.push(url); } },
    alert: (message: string) => { alerts.push(message); },
  });
  for (const name of ["formatDueDate", "addActionItem", "insertItemSorted", "updateCompletionWheel",
    "buildCaregiverActionLabel", "loadCaregiverActions"]) {
    const node = findNode(indexHtml, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    vm.runInContext(node.getText(), context);
  }
  const listener = findNode(indexHtml, (node) => ts.isCallExpression(node)
    && node.expression.getText() === "list.addEventListener"
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "click"
    && node.getText().includes(".cal-btn"));
  assert.ok(ts.isCallExpression(listener));
  const click = vm.runInContext("(" + listener.arguments[1].getText() + ")", context) as
    (event: unknown) => void;
  return {
    items, opened, alerts,
    load: () => vm.runInContext("loadCaregiverActions()", context) as Promise<void>,
    click: (item: RenderedItem) => click({ target: { matches: () => true, closest: () => item } }),
  };
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
    } else if (sql.startsWith("INSERT INTO caregiver_actions")) {
      const columns = sql.match(/INSERT INTO caregiver_actions \(([^)]+)\)/)?.[1].split(",").map((column) => column.trim());
      assert.ok(columns);
      assert.equal(columns.length, values.length);
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      row.id = "synthetic-action-" + (stored.length + 1);
      row.status = "open";
      stored.push(row);
      rows = [{ id: row.id, action_text: row.action_text, status: row.status }];
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
        "/api/parent/next-appointment", "/api/parent/caregiver-actions",
        "/api/caregiver/actions", "/api/calendar/template",
      ].includes(requested.pathname), "Only the tested local routes may be requested");
      if (init?.method === "POST") {
        assert.equal(typeof init.body, "string");
        posted.push(JSON.parse(init.body as string) as Record<string, unknown>);
      }
      const response = await localFetch(origin + requested.pathname + requested.search, { ...init, redirect: "manual" });
      if (init?.method === "POST") postedStatuses.push(response.status);
      return response;
    };
    const toolContext = vm.createContext({ user: { id: parentUserId }, activeConversationId: null, fetch: fetchBrowser });
    const getNext = vm.runInContext(toolSource("get_next_appointment"), toolContext) as
      () => Promise<{ status: string; appointment: { id: string } }>;
    const createAction = vm.runInContext(toolSource("create_caregiver_action"), toolContext) as
      (input: ToolInput) => Promise<{ status: string }>;
    async function readRenderedAction(): Promise<{ page: ReturnType<typeof caregiverPage>; action: Action }> {
      const response = await fetchBrowser("/api/caregiver/actions?userId=" + caregiverUserId);
      assert.equal(response.status, 200);
      const body = await response.json() as { actions: Action[] };
      assert.equal(body.actions.length, 1);
      const page = caregiverPage(fetchBrowser);
      await page.load();
      assert.equal(page.items.length, 1);
      return { page, action: body.actions[0] };
    }
    async function exportedUrl(page: ReturnType<typeof caregiverPage>): Promise<URL> {
      page.click(page.items[0]);
      assert.equal(page.alerts.length, 0);
      assert.equal(page.opened.length, 1);
      const response = await fetchBrowser(page.opened[0]);
      assert.equal(response.status, 302);
      const destination = response.headers.get("location");
      assert.ok(destination);
      await response.text();
      return new URL(destination);
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
      const { page, action } = await readRenderedAction();
      assert.equal(action.date, "2026-10-14");
      assert.equal(action.time, "2:30 PM");
      assert.equal(action.endTime, null);
      assert.equal(page.items[0].dataset.date, action.date);
      assert.equal(page.items[0].dataset.time, action.time);
      const url = await exportedUrl(page);
      assert.equal(url.origin, "https://calendar.google.com");
      assert.equal(url.searchParams.get("dates"), "20261014T143000/20261014T150000");
      assert.equal(url.searchParams.get("ctz"), "America/Chicago");
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
        const { page, action } = await readRenderedAction();
        assert.equal(action.date, null);
        assert.equal(action.time, null);
        assert.equal(action.endTime, null);
        page.click(page.items[0]);
        assert.equal(page.opened.length, 0);
        assert.equal(page.alerts.length, 1);
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
        const { page, action } = await readRenderedAction();
        assert.equal(action.date, "2026-10-15");
        assert.equal((await exportedUrl(page)).searchParams.get("dates"), "20261015/20261016");
      } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    });

    await t.test("explicit general date survives the real chain and exports all-day without a current-time fallback", async () => {
      stored.length = 0;
      assert.equal((await createAction({ text: "Synthetic general reminder", scheduledDate: "2026-10-15" })).status, "ok");
      const { page, action } = await readRenderedAction();
      assert.equal(action.date, "2026-10-15");
      assert.equal(action.time, null);
      assert.equal(action.endTime, null);
      assert.equal((await exportedUrl(page)).searchParams.get("dates"), "20261015/20261016");
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await getPool().end();
  }
});
