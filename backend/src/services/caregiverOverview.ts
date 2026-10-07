import { getPool } from "../db.js";

// Read-only data for the caregiver workspace. Everything here is scoped by the
// caregiver's *approved* parent_relationships row (the same rule that already
// guards /api/caregiver/actions and /api/caregiver/documents), and it only reads
// information the parent has confirmed: medications and appointments are written
// exclusively by confirmDocument, so nothing here is an unreviewed AI draft.

export interface CaregiverParentSummary {
  id: string;
  name: string;
}

export async function listApprovedParents(userId: string): Promise<CaregiverParentSummary[]> {
  const result = await getPool().query<{ id: string; full_name: string }>(
    `SELECT p.id, p.full_name
     FROM parent_relationships pr
     JOIN parents p ON p.id = pr.parent_id
     WHERE pr.user_id = $1 AND pr.status = 'approved'
     ORDER BY p.full_name ASC`,
    [userId]
  );
  return result.rows.map((row) => ({ id: row.id, name: row.full_name }));
}

export async function isApprovedCaregiverFor(userId: string, parentId: string): Promise<boolean> {
  const result = await getPool().query<{ one: number }>(
    `SELECT 1 AS one FROM parent_relationships
     WHERE user_id = $1 AND parent_id = $2 AND status = 'approved'
     LIMIT 1`,
    [userId, parentId]
  );
  return result.rows.length > 0;
}

export interface ConfirmedMedication {
  id: string;
  name: string;
  strength: string | null;
  instructions: string | null;
  // 'active' = currently listed; 'stopped' = a document the parent confirmed said to stop it.
  status: string;
  confirmedAt: string | null;
  sourceDocumentName: string | null;
}

export async function listConfirmedMedications(parentId: string): Promise<ConfirmedMedication[]> {
  const result = await getPool().query<{
    id: string;
    drug_name: string;
    strength: string | null;
    dose_instructions: string | null;
    status: string;
    confirmed_at: Date | null;
    document_name: string | null;
  }>(
    `SELECT m.id, m.drug_name, m.strength, m.dose_instructions, m.status, m.confirmed_at,
            d.document_name
     FROM medications m
     LEFT JOIN documents d ON d.id = m.source_document_id
     WHERE m.parent_id = $1 AND m.status IN ('active', 'stopped')
     ORDER BY (m.status = 'active') DESC, m.drug_name ASC
     LIMIT 100`,
    [parentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.drug_name,
    strength: row.strength,
    instructions: row.dose_instructions,
    status: row.status,
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    sourceDocumentName: row.document_name,
  }));
}

export interface ConfirmedAppointment {
  id: string;
  title: string | null;
  startsAt: string;
  timezone: string | null;
  location: string | null;
  provider: string | null;
  status: string | null;
}

export async function listUpcomingAppointments(parentId: string): Promise<ConfirmedAppointment[]> {
  const result = await getPool().query<{
    id: string;
    title: string | null;
    starts_at: Date;
    timezone: string | null;
    location: string | null;
    clinic: string | null;
    provider_name: string | null;
    status: string | null;
  }>(
    `SELECT id, title, starts_at, timezone, location, clinic, provider_name, status
     FROM appointments
     WHERE parent_id = $1 AND starts_at >= now()
     ORDER BY starts_at ASC
     LIMIT 20`,
    [parentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    timezone: row.timezone,
    location: row.location ?? row.clinic,
    provider: row.provider_name,
    status: row.status,
  }));
}

export interface ChangeSourceDocument {
  documentName: string;
  reviewedAt: string | null;
}

// The two most recent *confirmed* documents — the pair "what changed" compares
// (see getLatestChanges). Newest first.
export async function listChangeSourceDocuments(parentId: string): Promise<ChangeSourceDocument[]> {
  const result = await getPool().query<{ document_name: string; reviewed_at: Date | null }>(
    `SELECT document_name, reviewed_at
     FROM documents
     WHERE parent_id = $1 AND status = 'confirmed' AND reviewed_data IS NOT NULL
     ORDER BY reviewed_at DESC
     LIMIT 2`,
    [parentId]
  );
  return result.rows.map((row) => ({
    documentName: row.document_name,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  }));
}
