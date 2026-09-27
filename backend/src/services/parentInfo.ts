import { getPool } from "../db.js";

export interface NextAppointment {
  title: string | null;
  date: string;
  time: string;
  location: string | null;
}

export interface CurrentMedication {
  name: string;
  strength: string | null;
  instructions: string | null;
}

export async function getParentIdForUser(userId: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM parents WHERE user_id = $1",
    [userId]
  );
  return result.rows[0]?.id ?? null;
}

export async function getApprovedParentIdsForCaregiver(userId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ parent_id: string }>(
    "SELECT parent_id FROM parent_relationships WHERE user_id = $1 AND status = 'approved'",
    [userId]
  );
  return result.rows.map((row) => row.parent_id);
}

export async function getNextAppointment(parentId: string): Promise<NextAppointment | null> {
  const pool = getPool();
  const result = await pool.query<{
    title: string | null;
    starts_at: Date;
    timezone: string | null;
    location: string | null;
    clinic: string | null;
  }>(
    `SELECT title, starts_at, timezone, location, clinic
     FROM appointments
     WHERE parent_id = $1 AND starts_at >= now()
     ORDER BY starts_at ASC
     LIMIT 1`,
    [parentId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const timeZone = row.timezone ?? "UTC";
  const startsAt = new Date(row.starts_at);

  return {
    title: row.title,
    date: startsAt.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "long", day: "numeric" }),
    time: startsAt.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }),
    location: row.location ?? row.clinic,
  };
}

export async function getCurrentMedications(parentId: string): Promise<CurrentMedication[]> {
  const pool = getPool();
  const result = await pool.query<{
    drug_name: string;
    strength: string | null;
    dose_instructions: string | null;
  }>(
    `SELECT drug_name, strength, dose_instructions
     FROM medications
     WHERE parent_id = $1 AND status = 'active'
     ORDER BY drug_name ASC`,
    [parentId]
  );

  return result.rows.map((row) => ({
    name: row.drug_name,
    strength: row.strength,
    instructions: row.dose_instructions,
  }));
}
