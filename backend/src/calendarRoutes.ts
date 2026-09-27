import { Router } from "express";
import { z } from "zod";

const SCHEDULE_TIMEZONE = "America/Chicago";

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const timeSchema = z.string().trim().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$|^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:AM|PM)$/i,
).transform((value) => {
  const match = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i.exec(value);
  if (!match) return value;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
});

const calendarExportSchema = z.object({
  title: z.string().trim().min(1).max(500),
  date: z.string().refine(isCalendarDate, "A valid explicit calendar date is required"),
  time: timeSchema.optional(),
  endTime: timeSchema.optional(),
}).strict().superRefine((event, context) => {
  if (event.endTime && (!event.time || event.endTime < event.time)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endTime"], message: "End time requires a start time and cannot be earlier" });
  }
  if (event.date === "9999-12-31" && (!event.time || (!event.endTime && event.time >= "23:30"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Calendar end date is outside the supported range" });
  }
});

export function buildCalendarUrl(input: unknown): string {
  const event = calendarExportSchema.parse(input);
  const day = event.date.replaceAll("-", "");
  let dates: string;
  if (event.time) {
    // Keep explicit wall-clock values in the schedule's existing timezone.
    const start = `${day}T${event.time.replace(":", "")}00`;
    let end: string;
    if (event.endTime) {
      end = `${day}T${event.endTime.replace(":", "")}00`;
    } else {
      // A 30-minute export-only placeholder, never persisted as care data.
      const exportEnd = new Date(`${event.date}T${event.time}:00.000Z`);
      exportEnd.setUTCMinutes(exportEnd.getUTCMinutes() + 30);
      end = exportEnd.toISOString().slice(0, 19).replace(/[-:]/g, "");
    }
    dates = `${start}/${end}`;
  } else {
    // Google all-day ranges have an exclusive end date, with no clock time.
    const end = new Date(`${event.date}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    dates = `${day}/${end.toISOString().slice(0, 10).replaceAll("-", "")}`;
  }
  const url = new URL("https://calendar.google.com/calendar/render");
  url.search = new URLSearchParams({ action: "TEMPLATE", text: event.title, dates, ctz: SCHEDULE_TIMEZONE }).toString();
  return url.toString();
}

export const calendarRoutes = Router();

calendarRoutes.get("/template", (request, response, next) => {
  try {
    response.redirect(buildCalendarUrl(request.query));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).type("text/plain").send("Choose a valid event date and, if supplied, a valid time before adding it to your calendar.");
      return;
    }
    next(error);
  }
});
