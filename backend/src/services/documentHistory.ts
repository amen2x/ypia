import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";
import { actionableMedicationChangeTypes, reconcileCareState } from "./reconcileCareState.js";
import type { CareState, MedicationChange, NormalizedDocument, ReconciliationResult } from "../types.js";

export interface SaveDocumentExtractionInput {
  parentId: string;
  uploadedBy: string;
  documentName: string;
  mimeType: string;
  fileSizeBytes: number;
  contentHash: string;
  extractedData: NormalizedDocument;
}

// The raw file is not stored (documents.storage_key is required but there is no file store),
// so the key doubles as a per-parent fingerprint of the file's bytes.
export function contentKey(contentHash: string): string {
  return `unstored:sha256:${contentHash}`;
}

export interface ExistingDocument {
  id: string;
  status: string;
  extractedData: unknown;
}

// A document this parent already uploaded with byte-identical contents. Failed rows don't
// count: those never produced anything worth reusing.
export async function findDocumentByContent(parentId: string, contentHash: string): Promise<ExistingDocument | null> {
  const result = await getPool().query<{ id: string; status: string; extracted_data: unknown }>(
    `SELECT id, status, extracted_data FROM documents
     WHERE parent_id = $1 AND storage_key = $2 AND status <> 'failed'
     ORDER BY created_at ASC LIMIT 1`,
    [parentId, contentKey(contentHash)]
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, extractedData: row.extracted_data } : null;
}

export interface SavedDocument {
  id: string;
  duplicate: boolean;
}

// Inserts the extraction as an unconfirmed draft. If the same parent uploads the same bytes
// again (double tap, retry, two tabs) the earlier row wins and no second row is created; the
// advisory lock makes that hold even when both requests are in flight at once.
export async function saveDocumentExtraction(input: SaveDocumentExtractionInput): Promise<SavedDocument> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`doc:${input.parentId}:${input.contentHash}`]);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM documents WHERE parent_id = $1 AND storage_key = $2 AND status <> 'failed' ORDER BY created_at ASC LIMIT 1`,
      [input.parentId, contentKey(input.contentHash)]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { id: existing.rows[0].id, duplicate: true };
    }

    const id = randomUUID();
    await client.query(
      `INSERT INTO documents
         (id, parent_id, uploaded_by, document_name, document_type, storage_key, mime_type, file_size_bytes, extracted_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'needs_confirmation')`,
      [
        id,
        input.parentId,
        input.uploadedBy,
        input.documentName,
        input.extractedData.documentType,
        contentKey(input.contentHash),
        input.mimeType,
        input.fileSizeBytes,
        input.extractedData,
      ]
    );
    await client.query("COMMIT");
    return { id, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface ParentDocumentSummary {
  id: string;
  documentName: string;
  documentType: string;
  status: string;
  uploadedAt: string;
  reviewedAt: string | null;
}

// Safe metadata only: no extracted or reviewed content ever leaves through this list.
export async function listParentDocuments(parentId: string): Promise<ParentDocumentSummary[]> {
  const result = await getPool().query<{
    id: string;
    document_name: string;
    document_type: string;
    status: string;
    created_at: Date;
    reviewed_at: Date | null;
  }>(
    `SELECT id, document_name, document_type, status, created_at, reviewed_at
     FROM documents WHERE parent_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [parentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    documentName: row.document_name,
    documentType: row.document_type,
    status: row.status,
    uploadedAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  }));
}

// The parent's own draft, for reopening a review they left. Scoped to the parent in SQL.
export async function getParentDocumentDraft(
  parentId: string,
  documentId: string
): Promise<{ id: string; status: string; documentName: string; extractedData: unknown } | null> {
  const result = await getPool().query<{ id: string; status: string; document_name: string; extracted_data: unknown }>(
    `SELECT id, status, document_name, extracted_data FROM documents WHERE id = $1 AND parent_id = $2`,
    [documentId, parentId]
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, documentName: row.document_name, extractedData: row.extracted_data } : null;
}

export interface ChangeSummary {
  type: string;
  summary: string;
}

export type LatestChangesStatus = "ok" | "no_changes" | "not_enough_history" | "malformed_history";

export interface LatestChangesResult {
  status: LatestChangesStatus;
  changes: ChangeSummary[];
  documentCount: number;
}

// A stored reviewed document should carry RxNorm data on each medication, but older or
// hand-entered rows may not. Treat a missing value as "no RxNorm match" (name matching still
// works) rather than letting one such row take down the whole What Changed view.
function documentToCareState(document: NormalizedDocument): CareState {
  return {
    medications: document.medications.map((medication) => ({
      ...medication,
      rxnorm: medication.rxnorm ?? { rxcui: null, normalizedName: null },
    })),
    appointments: document.appointments,
    followUps: document.followUps,
    instructions: document.instructions,
  };
}

function isNormalizedDocumentShaped(value: unknown): value is NormalizedDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NormalizedDocument>;
  return (
    Array.isArray(candidate.medications) &&
    Array.isArray(candidate.appointments) &&
    Array.isArray(candidate.followUps) &&
    Array.isArray(candidate.instructions)
  );
}

export function describeMedicationChange(change: MedicationChange): ChangeSummary | null {
  switch (change.type) {
    case "ADDED":
      return { type: "medication_started", summary: `${change.medicationName} was added` };
    case "STOPPED":
      return { type: "medication_stopped", summary: `${change.medicationName} was stopped` };
    case "DOSE_CHANGED":
      return {
        type: "medication_changed",
        summary:
          change.previousDose && change.newDose
            ? `${change.medicationName} dose changed from ${change.previousDose} to ${change.newDose}`
            : `${change.medicationName} dose changed`,
      };
    case "FREQUENCY_CHANGED":
      return {
        type: "medication_changed",
        summary:
          change.previousFrequency && change.newFrequency
            ? `${change.medicationName} frequency changed from ${change.previousFrequency} to ${change.newFrequency}`
            : `${change.medicationName} frequency changed`,
      };
    case "DOSE_AND_FREQUENCY_CHANGED":
      return { type: "medication_changed", summary: `${change.medicationName} dose and frequency changed` };
    default:
      return null;
  }
}

export function summarizeReconciliation(reconciliation: ReconciliationResult): ChangeSummary[] {
  const changes: ChangeSummary[] = [];

  for (const change of reconciliation.medicationChanges) {
    if (!actionableMedicationChangeTypes.has(change.type)) continue;
    const described = describeMedicationChange(change);
    if (described) changes.push(described);
  }

  for (const appointment of reconciliation.newAppointments) {
    const label = [appointment.type, appointment.provider].filter(Boolean).join(" with ");
    changes.push({
      type: "appointment_added",
      summary: label ? `New appointment recorded: ${label}` : "A new appointment was recorded",
    });
  }

  for (const followUp of reconciliation.newFollowUps) {
    changes.push({ type: "followup_added", summary: followUp.description });
  }

  for (const instruction of reconciliation.newInstructions) {
    changes.push({ type: "instruction_added", summary: instruction });
  }

  return changes;
}

export async function getLatestChanges(parentId: string): Promise<LatestChangesResult> {
  const pool = getPool();
  // Only confirmed documents represent reviewed, user-verified care information —
  // an unreviewed draft extraction must never appear in "what changed".
  const result = await pool.query<{ reviewed_data: unknown }>(
    `SELECT reviewed_data
     FROM documents
     WHERE parent_id = $1 AND status = 'confirmed' AND reviewed_data IS NOT NULL
     ORDER BY reviewed_at DESC
     LIMIT 2`,
    [parentId]
  );

  const rows = result.rows;
  if (rows.length < 2) {
    return { status: "not_enough_history", changes: [], documentCount: rows.length };
  }

  const [newer, older] = rows;
  if (!isNormalizedDocumentShaped(newer.reviewed_data) || !isNormalizedDocumentShaped(older.reviewed_data)) {
    return { status: "malformed_history", changes: [], documentCount: rows.length };
  }

  const previousState = documentToCareState(older.reviewed_data);
  const newerDocument: NormalizedDocument = { ...newer.reviewed_data, medications: documentToCareState(newer.reviewed_data).medications as NormalizedDocument["medications"] };
  const reconciliation = reconcileCareState(previousState, newerDocument);
  const changes = summarizeReconciliation(reconciliation);

  return {
    status: changes.length > 0 ? "ok" : "no_changes",
    changes,
    documentCount: rows.length,
  };
}
