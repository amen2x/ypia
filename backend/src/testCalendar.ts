import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";
import { z } from "zod";
import { buildCalendarUrl, calendarRoutes } from "./calendarRoutes.js";

const title = "Synthetic appointment";

function calendarUrl(event: Record<string, unknown>): URL {
  return new URL(buildCalendarUrl({ title, ...event }));
}

test("explicit appointment time uses Chicago wall time without changing the date", () => {
  const url = calendarUrl({ date: "2026-10-14", time: "10:30 AM", endTime: "11:15 AM" });
  assert.equal(url.origin, "https://calendar.google.com");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), title);
  assert.equal(url.searchParams.get("dates"), "20261014T103000/20261014T111500");
  assert.equal(url.searchParams.get("ctz"), "America/Chicago");
});

test("an absent end time uses a 30-minute export-only placeholder", () => {
  const event = Object.freeze({ date: "2026-10-15", time: "10:30" });
  const url = calendarUrl(event);
  assert.equal(url.searchParams.get("dates"), "20261015T103000/20261015T110000");
  assert.deepEqual(event, { date: "2026-10-15", time: "10:30" });
});

for (const [date, expected] of [
  ["2026-10-14", "20261014T234500/20261015T001500"],
  ["2026-04-30", "20260430T234500/20260501T001500"],
  ["2026-12-31", "20261231T234500/20270101T001500"],
  ["2028-02-28", "20280228T234500/20280229T001500"],
]) {
  test(`30-minute export from ${date} rolls over midnight correctly`, () => {
    const url = calendarUrl({ date, time: "11:45 PM" });
    assert.equal(url.searchParams.get("dates"), expected);
    assert.equal(url.searchParams.get("ctz"), "America/Chicago");
  });
}

test("12-hour midnight and noon normalize correctly", () => {
  assert.equal(calendarUrl({ date: "2026-10-14", time: "12:00 AM", endTime: "12:00 PM" })
    .searchParams.get("dates"), "20261014T000000/20261014T120000");
});

for (const [date, expected] of [
  ["2026-10-14", "20261014/20261015"],
  ["2028-02-28", "20280228/20280229"],
  ["2028-02-29", "20280229/20280301"],
  ["2026-02-28", "20260228/20260301"],
  ["2026-04-30", "20260430/20260501"],
  ["2026-12-31", "20261231/20270101"],
]) {
  test(`date-only ${date} remains all-day with an exclusive next-day end`, () => {
    const dates = calendarUrl({ date }).searchParams.get("dates");
    assert.equal(dates, expected);
    assert.doesNotMatch(dates ?? "", /T|:/);
  });
}

const invalidInputs: Array<[string, Record<string, unknown>]> = [
  ["missing date", {}],
  ["time without a date", { time: "10:30 AM" }],
  ["empty date", { date: "" }],
  ["literal undefined", { date: "undefined" }],
  ["relative date", { date: "tomorrow" }],
  ["ambiguous local date", { date: "10/14/2026" }],
  ["ISO timestamp instead of a date", { date: "2026-10-14T15:30:00.000Z" }],
  ["non-leap February 29", { date: "2026-02-29" }],
  ["April rollover", { date: "2026-04-31" }],
  ["invalid month", { date: "2026-13-01" }],
  ["invalid year zero", { date: "0000-01-01" }],
  ["out-of-range all-day end", { date: "9999-12-31" }],
  ["out-of-range placeholder end", { date: "9999-12-31", time: "23:45" }],
  ["hour rollover", { date: "2026-10-14", time: "24:00" }],
  ["minute rollover", { date: "2026-10-14", time: "10:60" }],
  ["invalid 12-hour time", { date: "2026-10-14", time: "13:30 PM" }],
  ["relative time", { date: "2026-10-14", time: "now" }],
  ["ISO timestamp instead of a time", { date: "2026-10-14", time: "2026-10-14T15:30:00Z" }],
  ["end time without start time", { date: "2026-10-14", endTime: "11:15" }],
  ["end before start", { date: "2026-10-14", time: "11:15", endTime: "10:30" }],
  ["unexpected field", { date: "2026-10-14", reminder: "10 minutes" }],
  ["unknown timezone", { date: "2026-10-14", time: "10:30", timezone: "Mars/Olympus" }],
];

for (const [label, input] of invalidInputs) {
  test(`calendar export rejects ${label}`, () => {
    assert.throws(() => calendarUrl(input), z.ZodError);
  });
}

test("isolated calendar route redirects valid requests and rejects invalid ones", async () => {
  const app = express();
  app.use("/api/calendar", calendarRoutes);
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/calendar/template`;
    const query = new URLSearchParams({ title, date: "2026-10-14", time: "10:30 AM" });
    const valid = await fetch(`${base}?${query}`, { redirect: "manual" });
    assert.equal(valid.status, 302);
    const location = valid.headers.get("location");
    assert.ok(location);
    assert.equal(new URL(location).searchParams.get("dates"), "20261014T103000/20261014T110000");
    await valid.text();
    for (const query of [
      new URLSearchParams({ title }),
      new URLSearchParams({ title, date: "2026-02-30" }),
      new URLSearchParams([["title", title], ["date", "2026-10-14"], ["date", "2026-10-15"]]),
    ]) {
      const invalid = await fetch(`${base}?${query}`, { redirect: "manual" });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.headers.get("location"), null);
      assert.match(await invalid.text(), /Choose a valid event date/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// The browser formats stored instants with the caregiver workspace's own formatter (format.js).
const { fmtTime } = await import(new URL("../../static/js/caregiver/format.js", import.meta.url).href) as {
  fmtTime: (date: Date, timeZone?: string) => string;
};

function renderScheduleTime(timeZone: string): string {
  // Instants reach the browser as JSON strings; make sure they survive that round trip.
  const row = JSON.parse(JSON.stringify({ start_time: new Date("2026-10-14T15:30:00.000Z") })) as { start_time: string };
  return fmtTime(new Date(row.start_time), timeZone);
}

test("persisted timestamp serialized through JSON displays 10:30 AM in Chicago", () => {
  assert.match(renderScheduleTime("America/Chicago"), /^10:30\s*AM$/);
});

test("the same persisted instant correctly displays 3:30 PM in a UTC browser", () => {
  assert.match(renderScheduleTime("UTC"), /^3:30\s*PM$/);
});

test("optional location, details and an explicit timezone are carried into the Google link", () => {
  const url = calendarUrl({ date: "2026-10-14", time: "10:30", location: "Columbia Clinic", details: "Bring the list", timezone: "America/New_York" });
  assert.equal(url.searchParams.get("location"), "Columbia Clinic");
  assert.equal(url.searchParams.get("details"), "Bring the list");
  assert.equal(url.searchParams.get("ctz"), "America/New_York");
  assert.equal(url.searchParams.get("dates"), "20261014T103000/20261014T110000");
});

test("isolated .ics route returns a calendar attachment for valid input and 400 for invalid", async () => {
  const app = express();
  app.use("/api/calendar", calendarRoutes);
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/calendar/ics`;
    const valid = await fetch(`${base}?${new URLSearchParams({ title, date: "2026-10-14", time: "10:30 AM" })}`);
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get("content-type") ?? "", /^text\/calendar/);
    assert.match(valid.headers.get("content-disposition") ?? "", /attachment; filename="Synthetic-appointment\.ics"/);
    const body = await valid.text();
    assert.match(body, /^BEGIN:VCALENDAR\r\n/);
    assert.match(body, /DTSTART:20261014T153000Z\r\n/);
    const invalid = await fetch(`${base}?${new URLSearchParams({ title, date: "2026-02-30" })}`);
    assert.equal(invalid.status, 400);
    await invalid.text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
