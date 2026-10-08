import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "./app.js";
import {
  CalendarInputError,
  contentDisposition,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  icsCalendar,
  icsFilename,
  wallClockIn,
  zonedToInstant,
  type CalendarEvent,
  type CalendarWhen,
} from "./calendarExport.js";

// ---------------------------------------------------------------------------------------------
// Pure builders: Google Calendar URLs and .ics files from structured data.
// ---------------------------------------------------------------------------------------------

const NOW = new Date("2026-10-06T12:00:00Z");
const ev = (when: CalendarWhen, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ uid: "t-1@ypia", title: "Synthetic event", when, ...extra });
const g = (when: CalendarWhen, extra: Partial<CalendarEvent> = {}) => new URL(googleCalendarUrl(ev(when, extra)));

// Minimal RFC 5545 reader: unfold, split, return the VEVENT properties.
function parseIcs(text: string): { lines: string[]; props: Map<string, string> } {
  assert.ok(text.endsWith("\r\n"), "ends with CRLF");
  assert.ok(!/(^|[^\r])\n/.test(text), "no bare LF anywhere");
  const unfolded = text.replace(/\r\n[ \t]/g, "");
  const lines = unfolded.split("\r\n").filter(Boolean);
  const props = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(":");
    props.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return { lines, props };
}

test("Google: timed event in a known timezone keeps its wall-clock time and sets ctz", () => {
  const url = g({ kind: "zoned", date: "2026-10-14", time: "10:30", endTime: "11:15", timezone: "America/Chicago" });
  assert.equal(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("dates"), "20261014T103000/20261014T111500");
  assert.equal(url.searchParams.get("ctz"), "America/Chicago");
});

test("Google: missing end time defaults to 30 minutes, including across midnight and year end", () => {
  assert.equal(g({ kind: "zoned", date: "2026-10-14", time: "10:30", timezone: "America/Chicago" }).searchParams.get("dates"), "20261014T103000/20261014T110000");
  assert.equal(g({ kind: "floating", date: "2026-12-31", time: "23:45" }).searchParams.get("dates"), "20261231T234500/20270101T001500");
  assert.equal(g({ kind: "instant", start: new Date("2026-10-14T19:45:00Z") }).searchParams.get("dates"), "20261014T194500Z/20261014T201500Z");
});

test("Google: all-day uses date-only values with an exclusive end and no clock time", () => {
  const dates = g({ kind: "allDay", date: "2028-02-28" }).searchParams.get("dates");
  assert.equal(dates, "20280228/20280229");
  assert.doesNotMatch(dates ?? "", /T|:|Z/);
  assert.equal(g({ kind: "allDay", date: "2026-12-31" }).searchParams.get("dates"), "20261231/20270101");
});

test("Google: floating time omits ctz (never claims a timezone it does not know)", () => {
  const url = g({ kind: "floating", date: "2026-10-14", time: "09:30" });
  assert.equal(url.searchParams.get("ctz"), null);
  assert.equal(url.searchParams.get("dates"), "20261014T093000/20261014T100000");
});

test("Google: an absolute instant is sent in UTC so it is right in every timezone", () => {
  const url = g({ kind: "instant", start: new Date("2026-10-14T19:30:00Z"), end: new Date("2026-10-14T20:15:00Z") });
  assert.equal(url.searchParams.get("dates"), "20261014T193000Z/20261014T201500Z");
  assert.equal(url.searchParams.get("ctz"), null);
});

test("Google: location and description are included only when present", () => {
  const full = g({ kind: "allDay", date: "2026-10-14" }, { location: "Columbia Clinic", description: "With Dr. Patel" });
  assert.equal(full.searchParams.get("location"), "Columbia Clinic");
  assert.equal(full.searchParams.get("details"), "With Dr. Patel");
  const bare = g({ kind: "allDay", date: "2026-10-14" }, { location: "  ", description: "" });
  assert.equal(bare.searchParams.has("location"), false);
  assert.equal(bare.searchParams.has("details"), false);
});

test("Google: special characters survive URL encoding exactly", () => {
  const title = `Café & Co: "Dr. O'Neil" #1 + 100% <b>more</b> 病院 🩺`;
  const description = "Line one\nLine two; a, b & c = d";
  const raw = googleCalendarUrl(ev({ kind: "allDay", date: "2026-10-14" }, { title, description, location: "Rm #4 & 5" }));
  assert.doesNotMatch(raw, /[ "<>]/, "no raw spaces or quotes in the URL");
  const url = new URL(raw);
  assert.equal(url.searchParams.get("text"), title);
  assert.equal(url.searchParams.get("details"), description);
  assert.equal(url.searchParams.get("location"), "Rm #4 & 5");
});

const badEvents: Array<[string, CalendarEvent]> = [
  ["empty title", ev({ kind: "allDay", date: "2026-10-14" }, { title: "   " })],
  ["missing date", ev({ kind: "allDay", date: "" })],
  ["relative date", ev({ kind: "allDay", date: "tomorrow" })],
  ["April 31", ev({ kind: "allDay", date: "2026-04-31" })],
  ["non-leap Feb 29", ev({ kind: "floating", date: "2026-02-29", time: "10:00" })],
  ["24:00", ev({ kind: "floating", date: "2026-10-14", time: "24:00" })],
  ["10:60", ev({ kind: "floating", date: "2026-10-14", time: "10:60" })],
  ["12-hour text instead of 24-hour", ev({ kind: "floating", date: "2026-10-14", time: "10:30 AM" })],
  ["end before start", ev({ kind: "floating", date: "2026-10-14", time: "11:00", endTime: "10:00" })],
  ["unknown timezone", ev({ kind: "zoned", date: "2026-10-14", time: "10:00", timezone: "Mars/Olympus" })],
  ["invalid instant", ev({ kind: "instant", start: new Date("nonsense") })],
  ["instant end before start", ev({ kind: "instant", start: new Date("2026-10-14T10:00:00Z"), end: new Date("2026-10-14T09:00:00Z") })],
  ["out-of-range all-day end", ev({ kind: "allDay", date: "9999-12-31" })],
];
for (const [label, event] of badEvents) {
  test(`export rejects malformed input: ${label}`, () => {
    assert.throws(() => googleCalendarUrl(event), CalendarInputError);
    assert.throws(() => icsCalendar([event], NOW), CalendarInputError);
  });
}

test("ICS: required structure, CRLF line endings and a stable unique UID", () => {
  const text = icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, { uid: "appointment-abc123@ypia" })], NOW);
  const { lines, props } = parseIcs(text);
  assert.deepEqual(lines.slice(0, 5), ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Y.P.I.A.//Care Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]);
  assert.equal(lines.at(-1), "END:VCALENDAR");
  assert.ok(lines.indexOf("BEGIN:VEVENT") < lines.indexOf("END:VEVENT"));
  assert.equal(props.get("UID"), "appointment-abc123@ypia");
  assert.equal(props.get("DTSTAMP"), "20261006T120000Z");
  // exporting again produces the same UID, so a calendar updates the event instead of duplicating it
  assert.equal(parseIcs(icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, { uid: "appointment-abc123@ypia" })], new Date())).props.get("UID"), "appointment-abc123@ypia");
});

test("ICS: UID cannot contain characters that break the property", () => {
  const { props } = parseIcs(icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, { uid: "weird id;with\nbreaks@ypia" })], NOW));
  assert.equal(props.get("UID"), "weird-id-with-breaks@ypia");
});

test("ICS: all-day events use VALUE=DATE with an exclusive next-day end", () => {
  const { props } = parseIcs(icsCalendar([ev({ kind: "allDay", date: "2026-12-31" })], NOW));
  assert.equal(props.get("DTSTART;VALUE=DATE"), "20261231");
  assert.equal(props.get("DTEND;VALUE=DATE"), "20270101");
  assert.equal(props.has("DTSTART"), false);
});

test("ICS: floating times are written without Z or TZID; missing end defaults to 30 minutes", () => {
  const { props } = parseIcs(icsCalendar([ev({ kind: "floating", date: "2026-12-31", time: "23:45" })], NOW));
  assert.equal(props.get("DTSTART"), "20261231T234500");
  assert.equal(props.get("DTEND"), "20270101T001500");
  const withEnd = parseIcs(icsCalendar([ev({ kind: "floating", date: "2026-10-14", time: "09:30", endTime: "10:45" })], NOW)).props;
  assert.equal(withEnd.get("DTEND"), "20261014T104500");
});

test("ICS: instants are UTC; appointments without an end get 30 minutes", () => {
  const { props } = parseIcs(icsCalendar([ev({ kind: "instant", start: new Date("2026-10-14T19:30:00Z") })], NOW));
  assert.equal(props.get("DTSTART"), "20261014T193000Z");
  assert.equal(props.get("DTEND"), "20261014T200000Z");
  const withEnd = parseIcs(icsCalendar([ev({ kind: "instant", start: new Date("2026-10-14T19:30:00Z"), end: new Date("2026-10-14T21:00:00Z") })], NOW)).props;
  assert.equal(withEnd.get("DTEND"), "20261014T210000Z");
});

test("ICS: zoned times become correct UTC instants (no VTIMEZONE needed)", () => {
  const cases: Array<[string, string, string, string]> = [
    ["America/Chicago", "2026-10-14", "10:30", "20261014T153000Z"],   // CDT, UTC-5
    ["America/Chicago", "2026-11-10", "10:30", "20261110T163000Z"],   // CST, UTC-6
    ["Asia/Tokyo", "2026-10-14", "10:30", "20261014T013000Z"],        // UTC+9
    ["Asia/Kolkata", "2026-10-14", "10:30", "20261014T050000Z"],      // UTC+5:30
    ["Australia/Sydney", "2026-10-14", "10:30", "20261013T233000Z"],  // AEDT, UTC+11
    ["UTC", "2026-10-14", "10:30", "20261014T103000Z"],
  ];
  for (const [timezone, date, time, expected] of cases) {
    const { props } = parseIcs(icsCalendar([ev({ kind: "zoned", date, time, timezone })], NOW));
    assert.equal(props.get("DTSTART"), expected, `${timezone} ${date} ${time}`);
  }
  assert.doesNotMatch(icsCalendar([ev({ kind: "zoned", date: "2026-10-14", time: "10:30", timezone: "America/Chicago" })], NOW), /VTIMEZONE|TZID/);
});

test("timezone helpers handle daylight-saving gaps and overlaps deterministically", () => {
  assert.equal(zonedToInstant("2026-03-08", "02:30", "America/Chicago").toISOString(), "2026-03-08T08:30:00.000Z"); // gap -> just after
  assert.equal(zonedToInstant("2026-11-01", "01:30", "America/Chicago").toISOString(), "2026-11-01T06:30:00.000Z"); // overlap -> first
  assert.deepEqual(wallClockIn(new Date("2026-10-14T05:30:00Z"), "Asia/Tokyo"), { date: "2026-10-14", time: "14:30" });
  assert.deepEqual(wallClockIn(new Date("2026-10-14T05:30:00Z"), "America/Chicago"), { date: "2026-10-14", time: "00:30" });
});

test("ICS: SUMMARY, LOCATION and DESCRIPTION are escaped per RFC 5545", () => {
  const text = icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, {
    title: "Pick up; refill, then call\\office",
    location: "Rm 4; Bldg A, Columbia",
    description: "Line one\nLine two\r\nLine three\u0007\u0000",
  })], NOW);
  const { props } = parseIcs(text);
  assert.equal(props.get("SUMMARY"), "Pick up\\; refill\\, then call\\\\office");
  assert.equal(props.get("LOCATION"), "Rm 4\\; Bldg A\\, Columbia");
  assert.equal(props.get("DESCRIPTION"), "Line one\\nLine two\\nLine three");
  assert.equal(escapeIcsText("a:b"), "a:b");
  assert.doesNotMatch(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
});

test("ICS: optional properties are omitted when empty", () => {
  const { props } = parseIcs(icsCalendar([ev({ kind: "allDay", date: "2026-10-14" })], NOW));
  assert.equal(props.has("LOCATION"), false);
  assert.equal(props.has("DESCRIPTION"), false);
});

test("ICS: long lines fold at 75 octets and unfold losslessly, never splitting multi-byte characters", () => {
  const description = ("Bring the insurance card, 病院へ行く, café ☕ and a 🩺 note. ").repeat(12);
  const text = icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, { description, title: "Long title ".repeat(10) })], NOW);
  const encoder = new TextEncoder();
  for (const physical of text.split("\r\n")) assert.ok(encoder.encode(physical).length <= 75, `line over 75 octets: ${physical.length}`);
  const { props } = parseIcs(text);
  assert.equal(props.get("DESCRIPTION"), escapeIcsText(description.trim()));
  // every fragment is valid UTF-8 on its own (a split code point would decode to U+FFFD)
  for (const physical of text.split("\r\n")) assert.ok(!new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(physical)).includes("�"));
  assert.equal(foldIcsLine("short"), "short");
});

test("ICS: multiple events share one calendar", () => {
  const text = icsCalendar([ev({ kind: "allDay", date: "2026-10-14" }, { uid: "a@ypia" }), ev({ kind: "allDay", date: "2026-10-15" }, { uid: "b@ypia" })], NOW);
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.equal(text.match(/BEGIN:VCALENDAR/g)?.length, 1);
});

test("download filenames are ASCII-safe with a UTF-8 form for modern clients", () => {
  assert.equal(icsFilename("Dr. Patel / Cardiology: follow-up?").ascii, "Dr.-Patel-Cardiology-follow-up.ics");
  assert.equal(icsFilename("病院").ascii, "event.ics");
  assert.equal(icsFilename("   ").ascii, "event.ics");
  assert.match(contentDisposition("Café visit"), /^attachment; filename="Cafe-visit\.ics"; filename\*=UTF-8''Caf%C3%A9%20visit\.ics$/);
});

// ---------------------------------------------------------------------------------------------
// Real routes (backend/src/app.ts) over an in-memory stand-in for Postgres.
// ---------------------------------------------------------------------------------------------

const PARENT = "p-margaret";
const OTHER_PARENT = "p-other";
const CAREGIVER = "c-alex";
const STRANGER = "c-stranger";

interface ActionRow {
  id: string; parent_id: string; action_text: string; appointment_id: string | null;
  scheduled_date: string | null; scheduled_time: string | null; scheduled_end_time: string | null;
}

test("caregiver calendar routes: export from stored records, schedule tasks, never duplicate", async (t) => {
  process.env.TIMESCALE_SERVICE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/offline_test";
  process.env.DATABASE_URL = process.env.TIMESCALE_SERVICE_URL;
  t.mock.method(Pool.prototype, "connect", () => { throw new Error("Real database connections are forbidden"); });

  const appointments = [
    { id: "ap-timed", parent_id: PARENT, title: "Cardiology follow-up", starts_at: new Date("2026-10-14T19:30:00Z"), timezone: "America/Chicago", location: null as string | null, clinic: "Columbia Clinic", provider_name: "Dr. Patel" },
    { id: "ap-midnight", parent_id: PARENT, title: "Insurance renewal", starts_at: new Date("2026-10-20T05:00:00Z"), timezone: "America/Chicago", location: null, clinic: null, provider_name: null },
    { id: "ap-tokyo", parent_id: PARENT, title: "Tokyo date-only", starts_at: new Date("2026-10-19T15:00:00Z"), timezone: "Asia/Tokyo", location: "Room 4", clinic: null, provider_name: null },
    { id: "ap-notz", parent_id: PARENT, title: "No timezone on file", starts_at: new Date("2026-10-14T19:30:00Z"), timezone: null, location: null, clinic: null, provider_name: null },
    { id: "ap-other", parent_id: OTHER_PARENT, title: "Someone else", starts_at: new Date("2026-10-14T19:30:00Z"), timezone: "America/Chicago", location: null, clinic: null, provider_name: null },
  ];
  const actions: ActionRow[] = [
    { id: "act-timed", parent_id: PARENT, action_text: "Pick up prescription", appointment_id: null, scheduled_date: "2026-10-15", scheduled_time: "09:30", scheduled_end_time: "10:15" },
    { id: "act-noend", parent_id: PARENT, action_text: "Call pharmacy", appointment_id: null, scheduled_date: "2026-10-15", scheduled_time: "11:00", scheduled_end_time: null },
    { id: "act-dateonly", parent_id: PARENT, action_text: "Order grab bars", appointment_id: null, scheduled_date: "2026-10-16", scheduled_time: null, scheduled_end_time: null },
    { id: "act-none", parent_id: PARENT, action_text: "Take Margaret to the park on 2027-05-05 at 9am", appointment_id: null, scheduled_date: null, scheduled_time: null, scheduled_end_time: null },
    { id: "act-request-linked", parent_id: PARENT, action_text: "I need a ride to my appointment", appointment_id: "ap-timed", scheduled_date: "2031-01-01", scheduled_time: "09:00", scheduled_end_time: "09:45" },
    { id: "act-request-open", parent_id: PARENT, action_text: "I need a ride to my appointment", appointment_id: null, scheduled_date: null, scheduled_time: null, scheduled_end_time: null },
    { id: "act-other-parent", parent_id: OTHER_PARENT, action_text: "Not yours", appointment_id: null, scheduled_date: "2026-10-15", scheduled_time: null, scheduled_end_time: null },
  ];
  const schedule = [
    { id: "ev-church", parent_id: PARENT, title: "Bible study", category: "Church", start_time: new Date("2026-10-15T00:00:00Z"), end_time: new Date("2026-10-15T01:30:00Z"), location: "First Church", address: "100 Main St", with_whom: "Joan" },
    { id: "ev-noend", parent_id: PARENT, title: "Coffee", category: "Social", start_time: new Date("2026-10-15T14:00:00Z"), end_time: null as Date | null, location: null, address: null, with_whom: null },
  ];
  const writes: string[] = [];
  const executed: string[] = [];

  t.mock.method(Pool.prototype, "query", async (query: unknown, values: unknown[] = []) => {
    const sql = String(query).replace(/\s+/g, " ").trim();
    executed.push(sql);
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push(sql);
    let rows: Array<Record<string, unknown>> = [];
    if (sql.includes("FROM parent_relationships WHERE user_id = $1 AND status = 'approved'")) {
      rows = values[0] === CAREGIVER ? [{ parent_id: PARENT }] : [];
    } else if (sql === "SELECT full_name FROM parents WHERE id = $1") {
      rows = [{ full_name: values[0] === PARENT ? "Margaret Ellis" : "Walter Reed" }];
    } else if (sql.includes("FROM appointments WHERE id = $1")) {
      rows = appointments.filter((row) => row.id === values[0]);
    } else if (sql.includes("FROM caregiver_actions ca LEFT JOIN appointments a") && sql.includes("WHERE ca.id = $1")) {
      const row = actions.find((candidate) => candidate.id === values[0]);
      const appointment = appointments.find((candidate) => candidate.id === row?.appointment_id);
      rows = row ? [{ ...row, starts_at: appointment?.starts_at ?? null, timezone: appointment?.timezone ?? null, appt_title: appointment?.title ?? null, appt_location: appointment?.location ?? null, clinic: appointment?.clinic ?? null }] : [];
    } else if (sql.includes("FROM schedule WHERE id = $1")) {
      rows = schedule.filter((row) => row.id === values[0]);
    } else if (sql.startsWith("SELECT ca.id, ca.appointment_id FROM caregiver_actions ca JOIN parent_relationships pr")) {
      const row = actions.find((candidate) => candidate.id === values[1]);
      rows = row && values[0] === CAREGIVER && row.parent_id === PARENT ? [{ id: row.id, appointment_id: row.appointment_id }] : [];
    } else if (sql.startsWith("UPDATE caregiver_actions SET scheduled_date = $1::date")) {
      const row = actions.find((candidate) => candidate.id === values[3]);
      assert.ok(row);
      [row.scheduled_date, row.scheduled_time, row.scheduled_end_time] = [values[0], values[1], values[2]] as Array<string | null>;
      rows = [{ id: row.id, scheduled_date: row.scheduled_date, scheduled_time: row.scheduled_time, scheduled_end_time: row.scheduled_end_time }];
    } else {
      throw new Error("Unexpected SQL in offline test: " + sql.slice(0, 120));
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
    const exportUrl = (kind: string, id: string, format: string, userId = CAREGIVER) =>
      `${origin}/api/caregiver/calendar/${kind}/${id}?${new URLSearchParams({ userId, format })}`;
    const google = async (kind: string, id: string, userId = CAREGIVER) => {
      const response = await fetch(exportUrl(kind, id, "google", userId), { redirect: "manual" });
      await response.text();
      return { status: response.status, url: response.headers.get("location") ? new URL(response.headers.get("location") as string) : null };
    };
    const ics = async (kind: string, id: string, userId = CAREGIVER) => {
      const response = await fetch(exportUrl(kind, id, "ics", userId));
      const body = await response.text();
      return { status: response.status, headers: response.headers, body, props: response.status === 200 ? parseIcs(body).props : new Map<string, string>() };
    };
    const patch = async (id: string, body: Record<string, unknown>) => {
      const response = await fetch(`${origin}/api/caregiver/actions/${id}/schedule`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };

    await t.test("confirmed timed appointment: UTC instant, 30-minute default, location, provider, no medical details", async () => {
      const { status, url } = await google("appointment", "ap-timed");
      assert.equal(status, 302);
      assert.equal(url?.origin, "https://calendar.google.com");
      assert.equal(url?.searchParams.get("text"), "Cardiology follow-up");
      assert.equal(url?.searchParams.get("dates"), "20261014T193000Z/20261014T200000Z");
      assert.equal(url?.searchParams.get("location"), "Columbia Clinic");
      assert.equal(url?.searchParams.get("details"), "With Dr. Patel\nAdded from Margaret's care record in Y.P.I.A.");
      const file = await ics("appointment", "ap-timed");
      assert.equal(file.status, 200);
      assert.match(file.headers.get("content-type") ?? "", /^text\/calendar; charset=utf-8/);
      assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="Cardiology-follow-up\.ics"/);
      assert.equal(file.headers.get("cache-control"), "no-store");
      assert.equal(file.props.get("UID"), "appointment-ap-timed@ypia");
      assert.equal(file.props.get("DTSTART"), "20261014T193000Z");
      assert.equal(file.props.get("DTEND"), "20261014T200000Z");
      assert.equal(file.props.get("LOCATION"), "Columbia Clinic");
      assert.doesNotMatch(file.body, /medication|diagnos|prescription/i);
    });

    await t.test("appointment at local midnight is an all-day event, using the appointment's own timezone for the date", async () => {
      const chicago = await ics("appointment", "ap-midnight");
      assert.equal(chicago.props.get("DTSTART;VALUE=DATE"), "20261020");
      assert.equal(chicago.props.get("DTEND;VALUE=DATE"), "20261021");
      assert.equal(chicago.props.has("DTSTART"), false);
      const tokyo = await ics("appointment", "ap-tokyo"); // 15:00Z = 00:00 on Oct 20 in Tokyo, not Oct 19
      assert.equal(tokyo.props.get("DTSTART;VALUE=DATE"), "20261020");
      assert.equal((await google("appointment", "ap-midnight")).url?.searchParams.get("dates"), "20261020/20261021");
    });

    await t.test("appointment without a stored timezone still exports the correct instant (UTC), never a guessed zone", async () => {
      const file = await ics("appointment", "ap-notz");
      assert.equal(file.props.get("DTSTART"), "20261014T193000Z");
      assert.equal((await google("appointment", "ap-notz")).url?.searchParams.get("ctz"), null);
    });

    await t.test("scheduled caregiver task with start and end: floating time, no timezone claimed", async () => {
      const { url } = await google("action", "act-timed");
      assert.equal(url?.searchParams.get("text"), "Pick up prescription");
      assert.equal(url?.searchParams.get("dates"), "20261015T093000/20261015T101500");
      assert.equal(url?.searchParams.get("ctz"), null);
      assert.equal(url?.searchParams.get("details"), "Y.P.I.A. task for Margaret.");
      const file = await ics("action", "act-timed");
      assert.equal(file.props.get("DTSTART"), "20261015T093000");
      assert.equal(file.props.get("DTEND"), "20261015T101500");
    });

    await t.test("scheduled task with a start but no end uses the 30-minute default", async () => {
      assert.equal((await google("action", "act-noend")).url?.searchParams.get("dates"), "20261015T110000/20261015T113000");
      assert.equal((await ics("action", "act-noend")).props.get("DTEND"), "20261015T113000");
    });

    await t.test("task with only a date is all-day", async () => {
      assert.equal((await google("action", "act-dateonly")).url?.searchParams.get("dates"), "20261016/20261017");
      const file = await ics("action", "act-dateonly");
      assert.equal(file.props.get("DTSTART;VALUE=DATE"), "20261016");
    });

    await t.test("unscheduled task cannot be exported, and a date written in its text is never used", async () => {
      for (const id of ["act-none", "act-request-open"]) {
        const g1 = await google("action", id);
        assert.equal(g1.status, 422);
        assert.equal(g1.url, null);
        const i1 = await fetch(exportUrl("action", id, "ics"));
        assert.equal(i1.status, 422);
        assert.equal(((await i1.json()) as { code: string }).code, "not_scheduled");
      }
    });

    await t.test("parent request linked to a real appointment uses the appointment's stored time, not stray scheduled fields", async () => {
      const { url } = await google("action", "act-request-linked");
      assert.equal(url?.searchParams.get("dates"), "20261014T193000Z/20261014T200000Z"); // not 2031-01-01
      assert.equal(url?.searchParams.get("text"), "I need a ride to my appointment");
      assert.equal(url?.searchParams.get("location"), "Columbia Clinic");
      assert.match(url?.searchParams.get("details") ?? "", /Linked appointment: Cardiology follow-up\./);
    });

    await t.test("schedule events export as UTC instants; a missing end uses the 30-minute default; location + address combine", async () => {
      const full = await ics("schedule", "ev-church");
      assert.equal(full.props.get("DTSTART"), "20261015T000000Z");
      assert.equal(full.props.get("DTEND"), "20261015T013000Z");
      assert.equal(full.props.get("LOCATION"), "First Church\\, 100 Main St");
      assert.equal(full.props.get("DESCRIPTION"), "Y.P.I.A. schedule event for Margaret.\\nCategory: Church\\nWith Joan");
      assert.equal((await ics("schedule", "ev-noend")).props.get("DTEND"), "20261015T143000Z");
    });

    await t.test("authorization and input validation", async () => {
      assert.equal((await google("appointment", "ap-other")).status, 403);       // parent the caregiver is not linked to
      assert.equal((await google("action", "act-other-parent")).status, 403);
      assert.equal((await google("appointment", "ap-timed", STRANGER)).status, 403);
      assert.equal((await google("appointment", "does-not-exist")).status, 404);
      assert.equal((await fetch(`${origin}/api/caregiver/calendar/appointment/ap-timed?format=ics`)).status, 400); // no userId
      assert.equal((await fetch(exportUrl("note", "x", "ics"))).status, 400);                                      // unknown kind
      assert.equal((await fetch(exportUrl("appointment", "ap-timed", "pdf"))).status, 400);                        // unknown format
    });

    await t.test("exporting is read-only: repeated exports write nothing and always return the same event", async () => {
      const writesBefore = writes.length;
      const rowsBefore = JSON.stringify([actions, appointments, schedule]);
      const first = await ics("action", "act-timed");
      for (let i = 0; i < 4; i += 1) {
        const again = await ics("action", "act-timed");
        assert.equal(again.props.get("UID"), first.props.get("UID"));
        assert.equal(again.props.get("DTSTART"), first.props.get("DTSTART"));
        await google("action", "act-timed");
        await google("appointment", "ap-timed");
      }
      assert.equal(writes.length, writesBefore, "no INSERT/UPDATE/DELETE during export");
      assert.equal(JSON.stringify([actions, appointments, schedule]), rowsBefore, "stored records unchanged");
      assert.equal(actions.length, 7);
    });

    await t.test("scheduling an unscheduled task persists the date and makes it exportable (all-day, then timed)", async () => {
      assert.equal((await google("action", "act-request-open")).status, 422);
      let result = await patch("act-request-open", { userId: CAREGIVER, scheduledDate: "2026-10-22" });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json.action, { id: "act-request-open", date: "2026-10-22", time: null, endTime: null });
      assert.equal(actions.find((a) => a.id === "act-request-open")?.scheduled_date, "2026-10-22");
      assert.equal((await google("action", "act-request-open")).url?.searchParams.get("dates"), "20261022/20261023");

      result = await patch("act-request-open", { userId: CAREGIVER, scheduledDate: "2026-10-22", scheduledTime: "14:00" });
      assert.equal(result.status, 200);
      assert.equal((await google("action", "act-request-open")).url?.searchParams.get("dates"), "20261022T140000/20261022T143000");

      result = await patch("act-request-open", { userId: CAREGIVER, scheduledDate: "2026-10-22", scheduledTime: "14:00", scheduledEndTime: "15:30" });
      assert.equal((await ics("action", "act-request-open")).props.get("DTEND"), "20261022T153000");
    });

    await t.test("scheduling is idempotent: repeating it updates the same row and never creates another", async () => {
      const countBefore = actions.length;
      const a = await patch("act-none", { userId: CAREGIVER, scheduledDate: "2026-11-03", scheduledTime: "08:15" });
      const b = await patch("act-none", { userId: CAREGIVER, scheduledDate: "2026-11-03", scheduledTime: "08:15" });
      assert.deepEqual(a.json, b.json);
      assert.equal(actions.length, countBefore);
      assert.equal(writes.filter((w) => /^INSERT/i.test(w)).length, 0);
    });

    await t.test("a schedule can be cleared (explicit nulls) and then the task is unexportable again", async () => {
      const cleared = await patch("act-none", { userId: CAREGIVER, scheduledDate: null, scheduledTime: null, scheduledEndTime: null });
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.json.action, { id: "act-none", date: null, time: null, endTime: null });
      assert.equal((await google("action", "act-none")).status, 422);
    });

    await t.test("schedule validation rejects malformed input before touching the database", async () => {
      const bad: Array<Record<string, unknown>> = [
        {}, // no scheduledDate key: refuse to silently clear
        { scheduledTime: "09:00" },
        { scheduledDate: "2026-10-22", scheduledEndTime: "10:00" },                                // end without start
        { scheduledDate: "2026-10-22", scheduledTime: "10:00", scheduledEndTime: "09:00" },        // end before start
        { scheduledDate: "tomorrow" }, { scheduledDate: "2026-02-30" }, { scheduledDate: "10/22/2026" },
        { scheduledDate: "2026-10-22T09:00:00Z" },
        { scheduledDate: "2026-10-22", scheduledTime: "9am" }, { scheduledDate: "2026-10-22", scheduledTime: "25:00" },
        { scheduledDate: 20261022 }, { scheduledDate: [] }, { scheduledDate: "" }, { scheduledDate: "2026-10-22", scheduledTime: {} },
      ];
      const before = executed.length;
      for (const fields of bad) {
        const result = await patch("act-none", { userId: CAREGIVER, ...fields });
        assert.equal(result.status, 400, JSON.stringify(fields));
      }
      assert.equal((await patch("act-none", { scheduledDate: "2026-10-22" })).status, 400); // no userId
      assert.equal(executed.length, before, "validation failures never reach the database");
    });

    await t.test("scheduling authorization and appointment links", async () => {
      assert.equal((await patch("act-timed", { userId: STRANGER, scheduledDate: "2026-10-22" })).status, 404);
      assert.equal((await patch("act-other-parent", { userId: CAREGIVER, scheduledDate: "2026-10-22" })).status, 404);
      assert.equal((await patch("missing", { userId: CAREGIVER, scheduledDate: "2026-10-22" })).status, 404);
      const linked = await patch("act-request-linked", { userId: CAREGIVER, scheduledDate: "2026-10-22" });
      assert.equal(linked.status, 409);
      assert.match(String(linked.json.error), /appointment/i);
      assert.equal(actions.find((a) => a.id === "act-request-linked")?.scheduled_date, "2031-01-01"); // untouched
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
