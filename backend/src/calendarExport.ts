// One calendar model for every Y.P.I.A. item that can be exported (appointments, caregiver
// tasks, schedule events). Google Calendar links and .ics files are both generated from the
// same CalendarEvent, so the two formats can never disagree.
//
// Only STRUCTURED data goes in here. Nothing in this file parses dates or times out of text.
//
// Time model (see CalendarWhen). The data model has no per-parent timezone, so each kind says
// exactly what is known and exports it honestly:
//   allDay   - a date with no time: an all-day item.
//   floating - a wall-clock date + time with NO timezone (a caregiver task's scheduled_date /
//              scheduled_time). Exported as floating time: it lands at that clock time in the
//              importing calendar's own timezone. We never claim a timezone we do not know.
//   zoned    - a wall-clock date + time in a known IANA timezone.
//   instant  - an absolute moment (appointments.starts_at, schedule.start_time). Exported in UTC,
//              so it is correct in every viewer's timezone.
// Zoned events are converted to an instant for .ics, so the file never needs a VTIMEZONE block.

export const DEFAULT_DURATION_MINUTES = 30;
export const DEFAULT_TIMEZONE = "America/Chicago"; // legacy default of /api/calendar/template only

export class CalendarInputError extends Error {}

export type CalendarWhen =
  | { kind: "allDay"; date: string }
  | { kind: "floating"; date: string; time: string; endTime?: string }
  | { kind: "zoned"; date: string; time: string; endTime?: string; timezone: string }
  | { kind: "instant"; start: Date; end?: Date | null };

export interface CalendarEvent {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  when: CalendarWhen;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

// ---------- validation ----------

function assertWallClock(date: string, time?: string, endTime?: string): void {
  if (!isCalendarDate(date)) throw new CalendarInputError("A valid explicit calendar date is required");
  if (time !== undefined && !TIME_RE.test(time)) throw new CalendarInputError("Start time must be a valid 24-hour HH:mm time");
  if (endTime !== undefined) {
    if (!TIME_RE.test(endTime)) throw new CalendarInputError("End time must be a valid 24-hour HH:mm time");
    if (time === undefined) throw new CalendarInputError("End time requires a start time");
    if (endTime < time) throw new CalendarInputError("End time cannot be earlier than the start time");
  }
  // Keep the exclusive all-day end / 30-minute placeholder inside the supported date range.
  if (date === "9999-12-31" && (time === undefined || (endTime === undefined && time >= "23:30"))) {
    throw new CalendarInputError("Calendar end date is outside the supported range");
  }
}

export function validateEvent(event: CalendarEvent): void {
  if (typeof event.title !== "string" || event.title.trim().length === 0) throw new CalendarInputError("An event title is required");
  if (event.title.length > 500) throw new CalendarInputError("The event title is too long");
  if (event.description && event.description.length > 4000) throw new CalendarInputError("The event description is too long");
  if (event.location && event.location.length > 500) throw new CalendarInputError("The event location is too long");
  const when = event.when;
  switch (when.kind) {
    case "allDay":
      assertWallClock(when.date);
      return;
    case "floating":
      assertWallClock(when.date, when.time, when.endTime);
      return;
    case "zoned":
      if (!isValidTimezone(when.timezone)) throw new CalendarInputError("Unknown timezone");
      assertWallClock(when.date, when.time, when.endTime);
      return;
    case "instant":
      if (!(when.start instanceof Date) || !Number.isFinite(when.start.getTime())) throw new CalendarInputError("A valid start time is required");
      if (when.end && (!Number.isFinite(when.end.getTime()) || when.end.getTime() < when.start.getTime())) {
        throw new CalendarInputError("End time cannot be earlier than the start time");
      }
      return;
    default:
      throw new CalendarInputError("Unsupported event time");
  }
}

// ---------- date / time helpers ----------

const compactDate = (date: string) => date.replaceAll("-", "");
const compactTime = (time: string) => `${time.replace(":", "")}00`;

export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// date + start + 30 minutes, as wall-clock fields (rolls over midnight and month/year ends).
function defaultWallEnd(date: string, time: string): { date: string; time: string } {
  const end = new Date(`${date}T${time}:00.000Z`);
  end.setUTCMinutes(end.getUTCMinutes() + DEFAULT_DURATION_MINUTES);
  const iso = end.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

const utcStamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

function tzOffsetMs(instantMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// A wall-clock date/time in an IANA timezone -> the absolute instant. A time that does not exist
// (a spring-forward gap) resolves to the instant just after the gap; an ambiguous time (fall back)
// resolves to its first occurrence.
export function zonedToInstant(date: string, time: string, timezone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - tzOffsetMs(wall, timezone);
  const second = wall - tzOffsetMs(first, timezone);
  const matches = (instant: number) => {
    const local = wallClockIn(new Date(instant), timezone);
    return local.date === date && local.time === time;
  };
  const valid = [first, second].filter(matches);
  // Normal time: one answer. Overlap (clocks go back): both exist, take the first occurrence.
  // Gap (clocks spring forward, the time never happens): move forward past the gap.
  const instant = valid.length > 0 ? Math.min(...valid) : Math.max(first, second);
  return new Date(instant);
}

// An instant as the date / HH:mm wall clock of an IANA timezone.
export function wallClockIn(instant: Date, timezone: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return { date, time };
}

// ---------- resolved start/end ----------

type Resolved =
  | { allDay: true; startDate: string; endDate: string }
  | { allDay: false; floating: true; start: string; end: string }               // YYYYMMDDTHHMMSS
  | { allDay: false; floating: false; start: Date; end: Date; timezone?: string };

function resolve(when: CalendarWhen): Resolved {
  switch (when.kind) {
    case "allDay":
      return { allDay: true, startDate: when.date, endDate: nextDay(when.date) };
    case "floating": {
      const end = when.endTime ? { date: when.date, time: when.endTime } : defaultWallEnd(when.date, when.time);
      return { allDay: false, floating: true, start: `${compactDate(when.date)}T${compactTime(when.time)}`, end: `${compactDate(end.date)}T${compactTime(end.time)}` };
    }
    case "zoned": {
      const start = zonedToInstant(when.date, when.time, when.timezone);
      const end = when.endTime
        ? zonedToInstant(when.date, when.endTime, when.timezone)
        : new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000);
      return { allDay: false, floating: false, start, end, timezone: when.timezone };
    }
    case "instant": {
      const end = when.end && when.end.getTime() > when.start.getTime() ? when.end : new Date(when.start.getTime() + DEFAULT_DURATION_MINUTES * 60000);
      return { allDay: false, floating: false, start: when.start, end };
    }
  }
}

// ---------- Google Calendar ----------

// Opens Google Calendar's "add event" screen. No OAuth is involved: it is just a prefilled link.
export function googleCalendarUrl(event: CalendarEvent): string {
  validateEvent(event);
  const when = event.when;
  const params: Record<string, string> = { action: "TEMPLATE", text: event.title.trim() };

  if (when.kind === "allDay") {
    params.dates = `${compactDate(when.date)}/${compactDate(nextDay(when.date))}`;
  } else if (when.kind === "floating") {
    const r = resolve(when) as Extract<Resolved, { floating: true }>;
    params.dates = `${r.start}/${r.end}`; // no ctz: Google applies the user's own calendar timezone
  } else if (when.kind === "zoned") {
    const end = when.endTime ? { date: when.date, time: when.endTime } : defaultWallEnd(when.date, when.time);
    params.dates = `${compactDate(when.date)}T${compactTime(when.time)}/${compactDate(end.date)}T${compactTime(end.time)}`;
    params.ctz = when.timezone;
  } else {
    const r = resolve(when) as Extract<Resolved, { floating: false }>;
    params.dates = `${utcStamp(r.start)}/${utcStamp(r.end)}`; // UTC: unambiguous everywhere
  }
  if (event.location?.trim()) params.location = event.location.trim();
  if (event.description?.trim()) params.details = event.description.trim();

  const url = new URL("https://calendar.google.com/calendar/render");
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

// ---------- iCalendar (.ics) ----------

const CRLF = "\r\n";

export function escapeIcsText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 line folding: lines are at most 75 octets; continuation lines start with one space.
// Folds only between code points so multi-byte characters are never split.
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
      limit = 75;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join(CRLF);
}

const sanitizeUid = (uid: string) => uid.replace(/[^A-Za-z0-9@._-]/g, "-");

function eventLines(event: CalendarEvent, now: Date): string[] {
  validateEvent(event);
  const r = resolve(event.when);
  const lines = ["BEGIN:VEVENT", `UID:${sanitizeUid(event.uid)}`, `DTSTAMP:${utcStamp(now)}`];
  if (r.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(r.startDate)}`, `DTEND;VALUE=DATE:${compactDate(r.endDate)}`);
  } else if (r.floating) {
    lines.push(`DTSTART:${r.start}`, `DTEND:${r.end}`);
  } else {
    lines.push(`DTSTART:${utcStamp(r.start)}`, `DTEND:${utcStamp(r.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(event.title.trim())}`);
  if (event.location?.trim()) lines.push(`LOCATION:${escapeIcsText(event.location.trim())}`);
  if (event.description?.trim()) lines.push(`DESCRIPTION:${escapeIcsText(event.description.trim())}`);
  lines.push("END:VEVENT");
  return lines;
}

export function icsCalendar(events: CalendarEvent[], now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Y.P.I.A.//Care Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap((event) => eventLines(event, now)),
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

// An ASCII-safe download name (plus the UTF-8 form for clients that support it).
export function icsFilename(title: string): { ascii: string; utf8: string } {
  const base = title.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, " ").replace(/\s+/g, " ").slice(0, 60).trim() || "event";
  const ascii = base.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().replace(/\s+/g, "-") || "event";
  return { ascii: `${ascii}.ics`, utf8: `${base}.ics` };
}

export function contentDisposition(title: string): string {
  const { ascii, utf8 } = icsFilename(title);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}
