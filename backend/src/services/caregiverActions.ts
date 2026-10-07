import { getPool } from "../db.js";

const FALLBACK_TIMEZONE = "America/Chicago";

export interface CaregiverAction {
  id: string;
  parentId: string;
  text: string;
  status: string;
  source: string;
  createdAt: string;
  completedAt: string | null;
  parentName: string;
  conversationId: string | null;
  date: string | null;
  time: string | null;
  endTime: string | null;
  // Title of the linked appointment, when the action is tied to one.
  appointmentTitle: string | null;
}

export interface CreateCaregiverActionInput {
  parentId: string;
  createdByUserId: string;
  text: string;
  conversationId: string | null;
  appointmentId: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  scheduledEndTime: string | null;
  // Defaults to the table default ('voice') when omitted, so existing callers are unchanged.
  source?: string;
}

// The agent may supply an appointmentId, but it is never trusted merely because
// ElevenLabs sent it — it must resolve to a real appointment owned by this same
// parent, or the action is stored without a link (never invented, never rejected
// wholesale, since a bad/missing link shouldn't block relaying the request itself).
async function resolveOwnedAppointmentId(
  parentId: string,
  appointmentId: string | null
): Promise<string | null> {
  if (!appointmentId) return null;

  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM appointments WHERE id = $1 AND parent_id = $2",
    [appointmentId, parentId]
  );
  return result.rows[0]?.id ?? null;
}

export async function createCaregiverAction(
  input: CreateCaregiverActionInput
): Promise<{ id: string; text: string; status: string }> {
  const pool = getPool();
  const verifiedAppointmentId = await resolveOwnedAppointmentId(input.parentId, input.appointmentId);

  const columns = [
    "parent_id", "created_by_user_id", "action_text", "elevenlabs_conversation_id", "appointment_id",
    "scheduled_date", "scheduled_time", "scheduled_end_time",
  ];
  const values: unknown[] = [
    input.parentId,
    input.createdByUserId,
    input.text,
    input.conversationId,
    verifiedAppointmentId,
    input.scheduledDate,
    input.scheduledTime,
    input.scheduledEndTime,
  ];
  if (input.source) {
    columns.push("source");
    values.push(input.source);
  }

  const result = await pool.query<{ id: string; action_text: string; status: string }>(
    `INSERT INTO caregiver_actions (${columns.join(", ")})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
     RETURNING id, action_text, status`,
    values
  );

  const row = result.rows[0];
  return { id: row.id, text: row.action_text, status: row.status };
}

export async function listCaregiverActions(parentIds: string[]): Promise<CaregiverAction[]> {
  if (parentIds.length === 0) {
    return [];
  }

  const pool = getPool();
  const result = await pool.query<{
    id: string;
    parent_id: string;
    action_text: string;
    status: string;
    source: string;
    created_at: Date;
    completed_at: Date | null;
    parent_name: string;
    elevenlabs_conversation_id: string | null;
    appt_starts_at: Date | null;
    appt_timezone: string | null;
    appt_title: string | null;
    scheduled_date: Date | null;
    scheduled_time: string | null;
    scheduled_end_time: string | null;
  }>(
    `SELECT ca.id, ca.parent_id, ca.action_text, ca.status, ca.source, ca.created_at, ca.completed_at,
            ca.elevenlabs_conversation_id, p.full_name AS parent_name,
            a.starts_at AS appt_starts_at, a.timezone AS appt_timezone, a.title AS appt_title,
            ca.scheduled_date, ca.scheduled_time, ca.scheduled_end_time
     FROM caregiver_actions ca
     JOIN parents p ON p.id = ca.parent_id
     LEFT JOIN appointments a ON a.id = ca.appointment_id
     WHERE ca.parent_id = ANY($1::text[])
     ORDER BY (ca.status = 'open') DESC, ca.created_at DESC`,
    [parentIds]
  );

  return result.rows.map((row) => {
    // A linked appointment is always authoritative when present — its own stored
    // date/time wins even if a (possibly stale/conflicting) scheduled_* value is
    // also stored. Neither path ever reads the action's free-text prose.
    const timeZone = row.appt_timezone || FALLBACK_TIMEZONE;
    const startsAt = row.appt_starts_at ? new Date(row.appt_starts_at) : null;

    if (startsAt) {
      const localTime = startsAt.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
      // Midnight-local has no reliable way to be distinguished from a genuine
      // date-only appointment in the current schema, so treat it as date-only
      // rather than exposing a possibly-invented time.
      const hasExplicitTime = localTime !== "12:00 AM";
      return {
        id: row.id,
        parentId: row.parent_id,
        text: row.action_text,
        status: row.status,
        source: row.source,
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
        parentName: row.parent_name,
        conversationId: row.elevenlabs_conversation_id,
        // en-CA reliably formats as YYYY-MM-DD, matching the ISO date the frontend's
        // dataset.date/calendar-export route already expect everywhere else.
        date: startsAt.toLocaleDateString("en-CA", { timeZone }),
        time: hasExplicitTime ? localTime : null,
        endTime: null,
        appointmentTitle: row.appt_title ?? "Appointment",
      };
    }

    // No linked appointment: fall back to the explicitly-supplied general
    // scheduling fields, or no date at all if none were ever given.
    // pg parses DATE values at server-local midnight. Read local components so
    // a positive UTC offset cannot shift the stored calendar date backward.
    const scheduledDate = row.scheduled_date
      ? `${row.scheduled_date.getFullYear()}-${String(row.scheduled_date.getMonth() + 1).padStart(2, "0")}-${String(row.scheduled_date.getDate()).padStart(2, "0")}`
      : null;

    return {
      id: row.id,
      parentId: row.parent_id,
      text: row.action_text,
      status: row.status,
      source: row.source,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      parentName: row.parent_name,
      conversationId: row.elevenlabs_conversation_id,
      date: scheduledDate,
      time: scheduledDate && row.scheduled_time ? row.scheduled_time.slice(0, 5) : null,
      endTime: scheduledDate && row.scheduled_time && row.scheduled_end_time ? row.scheduled_end_time.slice(0, 5) : null,
      appointmentTitle: null,
    };
  });
}

export interface UpdateActionStatusInput {
  actionId: string;
  userId: string;
  status: "open" | "done";
}

export async function updateActionStatus(
  input: UpdateActionStatusInput
): Promise<{ id: string; status: string; completedAt: string | null } | null> {
  const pool = getPool();

  const authCheck = await pool.query<{ id: string }>(
    `SELECT ca.id
     FROM caregiver_actions ca
     JOIN parent_relationships pr
       ON pr.parent_id = ca.parent_id AND pr.user_id = $1 AND pr.status = 'approved'
     WHERE ca.id = $2`,
    [input.userId, input.actionId]
  );

  if (authCheck.rows.length === 0) {
    return null;
  }

  const result = await pool.query<{ id: string; status: string; completed_at: Date | null }>(
    `UPDATE caregiver_actions
     SET status = $1,
         completed_at = CASE WHEN $1 = 'done' THEN now() ELSE NULL END
     WHERE id = $2
     RETURNING id, status, completed_at`,
    [input.status, input.actionId]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export type ActionConversationResult =
  | { status: "not_available" }
  | { status: "syncing" }
  | { status: "ok"; summary: string | null; transcript: unknown };

export async function getActionConversation(
  actionId: string,
  userId: string
): Promise<ActionConversationResult | null> {
  const pool = getPool();

  const authCheck = await pool.query<{ elevenlabs_conversation_id: string | null; parent_id: string }>(
    `SELECT ca.elevenlabs_conversation_id, ca.parent_id
     FROM caregiver_actions ca
     JOIN parent_relationships pr
       ON pr.parent_id = ca.parent_id AND pr.user_id = $1 AND pr.status = 'approved'
     WHERE ca.id = $2`,
    [userId, actionId]
  );

  if (authCheck.rows.length === 0) {
    return null;
  }

  const { elevenlabs_conversation_id: conversationId, parent_id: parentId } = authCheck.rows[0];
  if (!conversationId) {
    return { status: "not_available" };
  }

  const conversationResult = await pool.query<{ transcript: unknown; summary: string | null }>(
    `SELECT transcript, summary FROM voice_conversations
     WHERE elevenlabs_conversation_id = $1 AND parent_id = $2`,
    [conversationId, parentId]
  );

  const row = conversationResult.rows[0];
  if (!row || !row.transcript) {
    return { status: "syncing" };
  }

  return { status: "ok", summary: row.summary, transcript: row.transcript };
}
