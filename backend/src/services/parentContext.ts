import { getPool } from "../db.js";

export interface ParentBackground {
  status: "ok" | "none";
  name: string;
  background: string | null;
}

export async function getParentBackground(parentId: string): Promise<ParentBackground | null> {
  const pool = getPool();
  const result = await pool.query<{ full_name: string; background_notes: string | null }>(
    "SELECT full_name, background_notes FROM parents WHERE id = $1",
    [parentId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const background = row.background_notes?.trim() || null;
  return {
    status: background ? "ok" : "none",
    name: row.full_name,
    background,
  };
}

export type ScheduleRange = "today" | "tomorrow" | "week" | "upcoming";

const VALID_RANGES: ReadonlySet<string> = new Set(["today", "tomorrow", "week", "upcoming"]);

export function isValidScheduleRange(value: unknown): value is ScheduleRange {
  return typeof value === "string" && VALID_RANGES.has(value);
}

const FALLBACK_TIMEZONE = "America/Chicago";

// The model/browser cannot be trusted to supply a real IANA identifier, so
// anything that fails to construct a DateTimeFormat falls back intentionally.
export function resolveTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return FALLBACK_TIMEZONE;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export interface ScheduleEvent {
  title: string;
  description: string | null;
  category: string;
  startTime: string;
  endTime: string;
  location: string | null;
  withWhom: string | null;
  status: string | null;
  attendanceStatus: string | null;
}

const MAX_SCHEDULE_RESULTS = 15;

export async function getParentSchedule(
  parentId: string,
  range: ScheduleRange,
  timezone: string
): Promise<ScheduleEvent[]> {
  const pool = getPool();
  const params: unknown[] = [parentId];
  let whereClause: string;

  switch (range) {
    case "today":
      params.push(timezone);
      whereClause = "DATE(start_time AT TIME ZONE $2) = DATE(NOW() AT TIME ZONE $2)";
      break;
    case "tomorrow":
      params.push(timezone);
      whereClause = "DATE(start_time AT TIME ZONE $2) = DATE((NOW() AT TIME ZONE $2) + INTERVAL '1 day')";
      break;
    case "week":
      params.push(timezone);
      whereClause =
        "DATE(start_time AT TIME ZONE $2) BETWEEN DATE(NOW() AT TIME ZONE $2) AND DATE((NOW() AT TIME ZONE $2) + INTERVAL '6 day')";
      break;
    case "upcoming":
      whereClause = "start_time >= NOW()";
      break;
  }

  const result = await pool.query<{
    title: string;
    description: string | null;
    category: string;
    start_time: Date;
    end_time: Date;
    location: string | null;
    with_whom: string | null;
    status: string | null;
    attendance_status: string | null;
  }>(
    `SELECT title, description, category, start_time, end_time, location, with_whom, status, attendance_status
     FROM schedule
     WHERE parent_id = $1 AND ${whereClause}
     ORDER BY start_time ASC
     LIMIT ${MAX_SCHEDULE_RESULTS}`,
    params
  );

  return result.rows.map((row) => ({
    title: row.title,
    description: row.description,
    category: row.category,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    location: row.location,
    withWhom: row.with_whom,
    status: row.status,
    attendanceStatus: row.attendance_status,
  }));
}
