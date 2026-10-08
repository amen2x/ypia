import { getPool } from "../db.js";
import { wallClockIn, type CalendarEvent } from "../calendarExport.js";

// Turns ONE stored Y.P.I.A. record into a calendar event, from its structured columns only:
//   appointment -> appointments.starts_at (+ timezone, title, location, provider)
//   action      -> the linked appointment when there is one (authoritative), otherwise the
//                  action's own scheduled_date / scheduled_time / scheduled_end_time
//   schedule    -> schedule.start_time / end_time
// Nothing is ever read out of free text (an action's wording, a document, a description).
// The record is the single source of truth: exporting reads it and never writes anything.

export type CalendarItemKind = "appointment" | "action" | "schedule";
export const CALENDAR_ITEM_KINDS: readonly CalendarItemKind[] = ["appointment", "action", "schedule"];

export type CalendarItemResult =
  | { status: "ok"; parentId: string; event: CalendarEvent }
  | { status: "not_scheduled"; parentId: string }
  | { status: "not_found" };

const FALLBACK_TIMEZONE = "America/Chicago"; // only used to decide "date-only" for an appointment without a timezone

async function parentFirstName(parentId: string): Promise<string> {
  const result = await getPool().query<{ full_name: string }>("SELECT full_name FROM parents WHERE id = $1", [parentId]);
  return (result.rows[0]?.full_name ?? "").trim().split(/\s+/)[0] || "your parent";
}

function describe(lines: Array<string | null | undefined | false>): string {
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

// An appointment's instant as an event. A start at local midnight in the appointment's own timezone
// carries no reliable time of day (the record cannot tell "midnight" from "date only"), so it is
// exported as an all-day item rather than a made-up 12:00 AM appointment.
function appointmentWhen(startsAt: Date, timezone: string | null): CalendarEvent["when"] {
  const local = wallClockIn(startsAt, timezone || FALLBACK_TIMEZONE);
  if (local.time === "00:00") return { kind: "allDay", date: local.date };
  return { kind: "instant", start: startsAt, end: null }; // appointments store a start only: default duration applies
}

export async function loadCalendarItem(kind: CalendarItemKind, id: string): Promise<CalendarItemResult> {
  const pool = getPool();

  if (kind === "appointment") {
    const result = await pool.query<{
      id: string; parent_id: string; title: string | null; starts_at: Date; timezone: string | null;
      location: string | null; clinic: string | null; provider_name: string | null;
    }>(
      `SELECT id, parent_id, title, starts_at, timezone, location, clinic, provider_name
       FROM appointments WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return { status: "not_found" };
    if (!row.starts_at) return { status: "not_scheduled", parentId: String(row.parent_id) };
    const first = await parentFirstName(String(row.parent_id));
    return {
      status: "ok",
      parentId: String(row.parent_id),
      event: {
        uid: `appointment-${row.id}@ypia`,
        title: row.title?.trim() || "Appointment",
        location: row.location ?? row.clinic ?? undefined,
        description: describe([row.provider_name && `With ${row.provider_name}`, `Added from ${first}'s care record in Y.P.I.A.`]),
        when: appointmentWhen(new Date(row.starts_at), row.timezone),
      },
    };
  }

  if (kind === "action") {
    const result = await pool.query<{
      id: string; parent_id: string; action_text: string; appointment_id: string | null;
      scheduled_date: string | null; scheduled_time: string | null; scheduled_end_time: string | null;
      starts_at: Date | null; timezone: string | null; appt_title: string | null; appt_location: string | null; clinic: string | null;
    }>(
      `SELECT ca.id, ca.parent_id, ca.action_text, ca.appointment_id,
              to_char(ca.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
              to_char(ca.scheduled_time, 'HH24:MI') AS scheduled_time,
              to_char(ca.scheduled_end_time, 'HH24:MI') AS scheduled_end_time,
              a.starts_at, a.timezone, a.title AS appt_title, a.location AS appt_location, a.clinic
       FROM caregiver_actions ca
       LEFT JOIN appointments a ON a.id = ca.appointment_id
       WHERE ca.id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return { status: "not_found" };
    const parentId = String(row.parent_id);
    const first = await parentFirstName(parentId);

    // A verified appointment link is authoritative (the same rule the task list already uses).
    if (row.appointment_id && row.starts_at) {
      return {
        status: "ok",
        parentId,
        event: {
          uid: `action-${row.id}@ypia`,
          title: row.action_text,
          location: row.appt_location ?? row.clinic ?? undefined,
          description: describe([`Y.P.I.A. task for ${first}.`, row.appt_title && `Linked appointment: ${row.appt_title}.`]),
          when: appointmentWhen(new Date(row.starts_at), row.timezone),
        },
      };
    }

    if (!row.scheduled_date) return { status: "not_scheduled", parentId };
    return {
      status: "ok",
      parentId,
      event: {
        uid: `action-${row.id}@ypia`,
        title: row.action_text,
        description: describe([`Y.P.I.A. task for ${first}.`]),
        // scheduled_date/time carry no timezone: date-only is all-day, a time is floating.
        when: row.scheduled_time
          ? { kind: "floating", date: row.scheduled_date, time: row.scheduled_time, endTime: row.scheduled_end_time ?? undefined }
          : { kind: "allDay", date: row.scheduled_date },
      },
    };
  }

  const result = await pool.query<{
    id: string; parent_id: string; title: string; category: string | null; start_time: Date; end_time: Date | null;
    location: string | null; address: string | null; with_whom: string | null;
  }>(
    `SELECT id, parent_id, title, category, start_time, end_time, location, address, with_whom
     FROM schedule WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return { status: "not_found" };
  if (!row.start_time) return { status: "not_scheduled", parentId: String(row.parent_id) };
  const parentId = String(row.parent_id);
  const first = await parentFirstName(parentId);
  return {
    status: "ok",
    parentId,
    event: {
      uid: `schedule-${row.id}@ypia`,
      title: row.title,
      location: [row.location, row.address].filter(Boolean).join(", ") || undefined,
      description: describe([`Y.P.I.A. schedule event for ${first}.`, row.category && `Category: ${row.category}`, row.with_whom && `With ${row.with_whom}`]),
      when: { kind: "instant", start: new Date(row.start_time), end: row.end_time ? new Date(row.end_time) : null },
    },
  };
}
