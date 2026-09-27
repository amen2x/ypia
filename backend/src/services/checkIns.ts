import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";

export async function checkInParent(
  parentId: string,
  submittedBy: string,
  activityNotes: string
): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Always log the raw check-in event
    await client.query(
      `INSERT INTO checkins (id, parent_id, submitted_by, activity_notes, checked_in_at, created_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), parentId, submittedBy, activityNotes]
    );

    // Update (or create) the streak, but only once per day
    const { rows } = await client.query(
      `SELECT streak, last_checkin_date, last_active_week
       FROM parent_streak WHERE parent_id = $1 FOR UPDATE`,
      [parentId]
    );

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // Monday
    const weekStartStr = weekStart.toISOString().slice(0, 10);

    if (rows.length === 0) {
      await client.query(
        `INSERT INTO parent_streak (parent_id, streak, last_checkin_date, last_active_week, updated_at)
         VALUES ($1, 1, $2, $3, now())`,
        [parentId, todayStr, weekStartStr]
      );
      await client.query("COMMIT");
      return 1;
    }

    const row = rows[0];
    const lastCheckin = row.last_checkin_date
      ? new Date(row.last_checkin_date).toISOString().slice(0, 10)
      : null;
    const lastWeek = row.last_active_week
      ? new Date(row.last_active_week).toISOString().slice(0, 10)
      : null;

    if (lastCheckin === todayStr) {
      await client.query("COMMIT");
      return row.streak; // already got streak credit today
    }

    let newStreak: number;
    if (lastWeek === weekStartStr) {
      newStreak = row.streak;
      await client.query(
        `UPDATE parent_streak SET last_checkin_date = $2, updated_at = now() WHERE parent_id = $1`,
        [parentId, todayStr]
      );
    } else {
      const prevWeek = new Date(weekStart);
      prevWeek.setDate(weekStart.getDate() - 7);
      const prevWeekStr = prevWeek.toISOString().slice(0, 10);

      newStreak = lastWeek === prevWeekStr ? row.streak + 1 : 1;

      await client.query(
        `UPDATE parent_streak
         SET streak = $2, last_checkin_date = $3, last_active_week = $4, updated_at = now()
         WHERE parent_id = $1`,
        [parentId, newStreak, todayStr, weekStartStr]
      );
    }

    await client.query("COMMIT");
    return newStreak;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}