import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import test from "node:test";
import vm from "node:vm";
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

test("an edited October 15 date wins and an absent end time does not invent a duration", () => {
  const url = calendarUrl({ date: "2026-10-15", time: "10:30" });
  assert.equal(url.searchParams.get("dates"), "20261015T103000/20261015T103000");
});

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
  ["hour rollover", { date: "2026-10-14", time: "24:00" }],
  ["minute rollover", { date: "2026-10-14", time: "10:60" }],
  ["invalid 12-hour time", { date: "2026-10-14", time: "13:30 PM" }],
  ["relative time", { date: "2026-10-14", time: "now" }],
  ["ISO timestamp instead of a time", { date: "2026-10-14", time: "2026-10-14T15:30:00Z" }],
  ["end time without start time", { date: "2026-10-14", endTime: "11:15" }],
  ["end before start", { date: "2026-10-14", time: "11:15", endTime: "10:30" }],
  ["unexpected field", { date: "2026-10-14", timezone: "UTC" }],
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
    assert.equal(new URL(location).searchParams.get("dates"), "20261014T103000/20261014T103000");
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

const html = await readFile(new URL("../../templates/index.html", import.meta.url), "utf8");
const clickSource = html.match(/\/\/ Send to Google Calendar\s*([\s\S]*?)\/\/ Change urgency/)?.[1];
assert.ok(clickSource, "Expected the actual Google Calendar click handler");

test("actual calendar click handler preserves selected date and optional times", () => {
  for (const dataset of [
    { date: "2026-10-14" },
    { date: "2026-10-15", time: "10:30 AM", endTime: "11:15 AM" },
  ]) {
    let click: (() => void) | undefined;
    const opened: Array<{ url: URL; target: string }> = [];
    const event = { target: {
      matches: () => true,
      closest: () => ({ dataset, querySelector: () => ({ textContent: title }) }),
    } };
    vm.runInNewContext(clickSource, {
      list: { addEventListener: (_name: string, callback: (event: unknown) => void) => { click = () => callback(event); } },
      window: { open: (url: string, target: string) => { opened.push({ url: new URL(url), target }); } },
      alert: () => { assert.fail("A valid date should export"); },
      URLSearchParams,
      CAREGIVER_API_BASE: "http://localhost:3000",
    });
    assert.ok(click);
    click();
    assert.equal(opened.length, 1);
    const { url, target } = opened[0];
    assert.equal(url.origin, "http://localhost:3000");
    assert.equal(url.pathname, "/api/calendar/template");
    assert.equal(url.searchParams.get("title"), title);
    assert.equal(url.searchParams.get("date"), dataset.date);
    assert.equal(url.searchParams.get("time"), dataset.time ?? null);
    assert.equal(url.searchParams.get("endTime"), dataset.endTime ?? null);
    assert.equal(target, "_blank");
  }
});

test("actual calendar click handler blocks missing dates instead of using now", () => {
  for (const date of [undefined, "", "undefined"]) {
    let click: (() => void) | undefined;
    const alerts: string[] = [];
    const event = { target: {
      matches: () => true,
      closest: () => ({ dataset: { date }, querySelector: () => ({ textContent: title }) }),
    } };
    vm.runInNewContext(clickSource, {
      list: { addEventListener: (_name: string, callback: (event: unknown) => void) => { click = () => callback(event); } },
      window: { open: () => { assert.fail("An undated action must not open a calendar event"); } },
      alert: (message: string) => { alerts.push(message); },
      URLSearchParams,
      CAREGIVER_API_BASE: "http://localhost:3000",
    });
    assert.ok(click);
    click();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /choose a date/i);
  }
});

const dateSource = html.match(/function formatEventDate\([\s\S]*?(?=function renderEvents\()/)?.[0];
assert.ok(dateSource, "Expected the actual schedule date formatter");

function renderScheduleDate(timeZone: string, locale: string): string {
  const row = JSON.parse(JSON.stringify({
    start_time: new Date("2026-10-14T15:30:00.000Z"),
    end_time: new Date("2026-10-14T16:15:00.000Z"),
  })) as { start_time: string; end_time: string };
  const formatter = vm.runInNewContext(`${dateSource}\nformatEventDate`, {
    Date,
    Intl: { DateTimeFormat: function (_locale: unknown, options: Intl.DateTimeFormatOptions) {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } },
  }) as (start: string, end: string) => string;
  return formatter(row.start_time, row.end_time);
}

test("persisted timestamp serialized through JSON displays October 14 at 10:30 AM in Chicago", () => {
  const displayed = renderScheduleDate("America/Chicago", "en-US");
  assert.match(displayed, /Oct 14/);
  assert.match(displayed, /10:30\s*AM/);
  assert.match(displayed, /11:15\s*AM/);
});

test("the same persisted instant correctly displays 15:30 in a UTC browser", () => {
  const displayed = renderScheduleDate("UTC", "en-GB");
  assert.match(displayed, /14 Oct/);
  assert.match(displayed, /15:30/);
  assert.match(displayed, /16:15/);
});
