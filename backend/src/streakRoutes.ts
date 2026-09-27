import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DatabaseConfigurationError, getPool } from "./db.js";

// ---------------------------------------------------------------------
// Weekly check-in streak for the child (family member).
//
// Rule: check on your parent at least once a week (Sunday to Saturday).
//   - check in again the same week -> streak stays the same
//   - check in the next week       -> streak + 1
//   - miss a whole week            -> starts over at 1
//
//   GET  /api/streak?userId=...         -> the child's streak right now
//   POST /api/streak/checkin { userId } -> check in, then the new streak
//
// Uses the team's child_streak table (child_id TEXT, streak, updated_at).
// updated_at = the time of the last check-in, in TIME_ZONE.
// ---------------------------------------------------------------------

const TIME_ZONE = "America/Chicago"; // decides when a week starts and ends

export const streakRoutes = Router();

class StreakError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const userSchema = z.object({ userId: z.string().trim().min(1).max(100) });

interface StreakRow {
  today: string;             // "2026-09-27" in TIME_ZONE
  id: number | null;         // null = never checked in
  streak: number | null;
  last_date: string | null;  // day of the last check-in
  last_time: string | null;  // exact time of the last check-in
}

export interface StreakStatus {
  streak: number;              // weeks in a row (0 = no streak right now)
  checkedInThisWeek: boolean;
  lastCheckin: string | null;  // "2026-09-27T03:40:00"
}

// ----- week math -----

// Number of the week a date is in (weeks start on Sunday).
function weekNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const days = Date.UTC(year, month - 1, day) / 86_400_000;
  // 1970-01-01 was a Thursday, so +4 lines weeks up with Sundays.
  return Math.floor((days + 4) / 7);
}

// 0 = checked in this week, 1 = last week, 2+ = missed at least a week
function weeksSinceLastCheckin(row: StreakRow): number | null {
  if (!row.last_date) return null;
  return Math.max(0, weekNumber(row.today) - weekNumber(row.last_date));
}

function toStatus(row: StreakRow): StreakStatus {
  const weeksAgo = weeksSinceLastCheckin(row);
  const streak = row.streak ?? 0;
  return {
    // Missed a whole week: the streak is broken, so show 0.
    streak: weeksAgo === null || weeksAgo >= 2 ? 0 : Math.max(streak, 1),
    checkedInThisWeek: weeksAgo === 0,
    lastCheckin: row.last_time,
  };
}

// ----- database -----

async function readRow(client: PoolClient, childId: string): Promise<StreakRow> {
  // If there are ever 2 rows for one child, the newest one wins.
  const { rows } = await client.query<StreakRow>(
    `SELECT to_char(timezone($2, now())::date, 'YYYY-MM-DD') AS today,
            s.id, s.streak,
            to_char(s.updated_at, 'YYYY-MM-DD') AS last_date,
            to_char(s.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_time
     FROM (SELECT 1) AS one
     LEFT JOIN LATERAL (
       SELECT id, streak, updated_at
       FROM child_streak
       WHERE child_id = $1
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) AS s ON true`,
    [childId, TIME_ZONE],
  );
  return rows[0];
}

// Only a family member with an approved link to a parent has a streak.
async function requireChild(client: PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ linked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM parent_relationships
       WHERE user_id = $1 AND status = 'approved'
     ) AS linked`,
    [userId],
  );
  if (!rows[0]?.linked) {
    throw new StreakError(403, "Only a family member linked to a parent has a check-in streak");
  }
}

export async function getStreak(userId: string): Promise<StreakStatus> {
  const client = await getPool().connect();
  try {
    await requireChild(client, userId);
    return toStatus(await readRow(client, userId));
  } finally {
    client.release();
  }
}

export async function checkIn(userId: string): Promise<StreakStatus> {
  const client = await getPool().connect();
  try {
    await requireChild(client, userId);
    await client.query("BEGIN");
    // One check-in at a time per child, so a double tap can't make 2 rows.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('child_streak:' || $1))", [userId]);

    const row = await readRow(client, userId);
    const weeksAgo = weeksSinceLastCheckin(row);

    let newStreak: number;
    if (weeksAgo === null) newStreak = 1;                              // first check-in ever
    else if (weeksAgo === 0) newStreak = Math.max(row.streak ?? 0, 1); // already this week
    else if (weeksAgo === 1) newStreak = (row.streak ?? 0) + 1;        // kept it going
    else newStreak = 1;                                                // missed a week

    if (row.id === null) {
      await client.query(
        `INSERT INTO child_streak (child_id, streak, updated_at)
         VALUES ($1, $2, timezone($3, now()))`,
        [userId, newStreak, TIME_ZONE],
      );
    } else {
      await client.query(
        `UPDATE child_streak
         SET streak = $2, updated_at = timezone($3, now())
         WHERE id = $1`,
        [row.id, newStreak, TIME_ZONE],
      );
    }

    const status = toStatus(await readRow(client, userId));
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ----- routes -----

function parseUser(data: unknown): string {
  const result = userSchema.safeParse(data);
  if (!result.success) throw new StreakError(400, "userId is required");
  return result.data.userId;
}

// Each route handles its own errors, so the team's error handler is never affected.
function handle(route: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response) => {
    try {
      await route(request, response);
    } catch (error: unknown) {
      if (error instanceof StreakError) {
        response.status(error.status).json({ error: error.message });
      } else if (error instanceof DatabaseConfigurationError) {
        response.status(500).json({ error: "The database is not configured" });
      } else {
        console.error("Streak route failed:", error);
        response.status(500).json({ error: "Something went wrong. Please try again." });
      }
    }
  };
}

streakRoutes.get("/api/streak", handle(async (request, response) => {
  response.json(await getStreak(parseUser(request.query)));
}));

streakRoutes.post("/api/streak/checkin", handle(async (request, response) => {
  response.json(await checkIn(parseUser(request.body)));
}));