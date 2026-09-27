import { getPool } from "../db.js";

export interface CaregiverAction {
  id: string;
  text: string;
  status: string;
  source: string;
  createdAt: string;
  completedAt: string | null;
  parentName: string;
  conversationId: string | null;
}

export interface CreateCaregiverActionInput {
  parentId: string;
  createdByUserId: string;
  text: string;
  conversationId: string | null;
}

export async function createCaregiverAction(
  input: CreateCaregiverActionInput
): Promise<{ id: string; text: string; status: string }> {
  const pool = getPool();
  const result = await pool.query<{ id: string; action_text: string; status: string }>(
    `INSERT INTO caregiver_actions (parent_id, created_by_user_id, action_text, elevenlabs_conversation_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, action_text, status`,
    [input.parentId, input.createdByUserId, input.text, input.conversationId]
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
    action_text: string;
    status: string;
    source: string;
    created_at: Date;
    completed_at: Date | null;
    parent_name: string;
    elevenlabs_conversation_id: string | null;
  }>(
    `SELECT ca.id, ca.action_text, ca.status, ca.source, ca.created_at, ca.completed_at,
            ca.elevenlabs_conversation_id, p.full_name AS parent_name
     FROM caregiver_actions ca
     JOIN parents p ON p.id = ca.parent_id
     WHERE ca.parent_id = ANY($1::text[])
     ORDER BY (ca.status = 'open') DESC, ca.created_at DESC`,
    [parentIds]
  );

  return result.rows.map((row) => ({
    id: row.id,
    text: row.action_text,
    status: row.status,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    parentName: row.parent_name,
    conversationId: row.elevenlabs_conversation_id,
  }));
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
