import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  CalendarInputError,
  DEFAULT_TIMEZONE,
  contentDisposition,
  googleCalendarUrl,
  icsCalendar,
  isCalendarDate,
  isValidTimezone,
  type CalendarEvent,
} from "./calendarExport.js";

export { isCalendarDate };

const timeSchema = z.string().trim().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$|^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:AM|PM)$/i,
).transform((value) => {
  const match = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i.exec(value);
  if (!match) return value;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
});

// Generic "format this explicit date/time" input. The caregiver workspace exports stored records
// by id instead (see /api/caregiver/calendar/:kind/:id in app.ts); this stays as the plain formatter.
const calendarExportSchema = z.object({
  title: z.string().trim().min(1).max(500),
  date: z.string().refine(isCalendarDate, "A valid explicit calendar date is required"),
  time: timeSchema.optional(),
  endTime: timeSchema.optional(),
  location: z.string().trim().max(500).optional(),
  details: z.string().trim().max(4000).optional(),
  // IANA timezone for the wall-clock time. Defaults to the schedule's historical zone.
  timezone: z.string().trim().refine(isValidTimezone, "Unknown timezone").optional(),
}).strict().superRefine((event, context) => {
  if (event.endTime && (!event.time || event.endTime < event.time)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endTime"], message: "End time requires a start time and cannot be earlier" });
  }
  if (event.date === "9999-12-31" && (!event.time || (!event.endTime && event.time >= "23:30"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Calendar end date is outside the supported range" });
  }
});

function toEvent(input: unknown): CalendarEvent {
  const event = calendarExportSchema.parse(input);
  const timezone = event.timezone ?? DEFAULT_TIMEZONE;
  const uid = `generic-${createHash("sha1").update([event.title, event.date, event.time ?? "", event.endTime ?? "", timezone].join("\u0000")).digest("hex").slice(0, 24)}@ypia`;
  return {
    uid,
    title: event.title,
    description: event.details,
    location: event.location,
    when: event.time
      ? { kind: "zoned", date: event.date, time: event.time, endTime: event.endTime, timezone }
      : { kind: "allDay", date: event.date },
  };
}

export function buildCalendarUrl(input: unknown): string {
  const event = toEvent(input);
  const url = new URL(googleCalendarUrl(event));
  // The historical route always sent a timezone, even for all-day items.
  if (!url.searchParams.has("ctz")) url.searchParams.set("ctz", (event.when.kind === "zoned" ? event.when.timezone : DEFAULT_TIMEZONE));
  return url.toString();
}

export function buildIcs(input: unknown, now: Date = new Date()): { body: string; title: string } {
  const event = toEvent(input);
  return { body: icsCalendar([event], now), title: event.title };
}

export const calendarRoutes = Router();

const INVALID_MESSAGE = "Choose a valid event date and, if supplied, a valid time before adding it to your calendar.";

calendarRoutes.get("/template", (request, response, next) => {
  try {
    response.redirect(buildCalendarUrl(request.query));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof CalendarInputError) {
      response.status(400).type("text/plain").send(INVALID_MESSAGE);
      return;
    }
    next(error);
  }
});

calendarRoutes.get("/ics", (request, response, next) => {
  try {
    const { body, title } = buildIcs(request.query);
    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader("Content-Disposition", contentDisposition(title));
    response.setHeader("Cache-Control", "no-store");
    response.send(body);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof CalendarInputError) {
      response.status(400).type("text/plain").send(INVALID_MESSAGE);
      return;
    }
    next(error);
  }
});
