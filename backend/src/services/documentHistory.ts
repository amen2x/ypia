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
  extractedData: NormalizedDocument;
}

export async function saveDocumentExtraction(input: SaveDocumentExtractionInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO documents
       (id, parent_id, uploaded_by, document_name, document_type, storage_key, mime_type, file_size_bytes, extracted_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      input.parentId,
      input.uploadedBy,
      input.documentName,
      input.extractedData.documentType,
      `unstored:${randomUUID()}`,
      input.mimeType,
      input.fileSizeBytes,
      input.extractedData,
    ]
  );
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

function documentToCareState(document: NormalizedDocument): CareState {
  return {
    medications: document.medications,
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

function describeMedicationChange(change: MedicationChange): ChangeSummary | null {
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

function summarizeReconciliation(reconciliation: ReconciliationResult): ChangeSummary[] {
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
  const result = await pool.query<{ extracted_data: unknown }>(
    `SELECT extracted_data
     FROM documents
     WHERE parent_id = $1 AND extracted_data IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 2`,
    [parentId]
  );

  const rows = result.rows;
  if (rows.length < 2) {
    return { status: "not_enough_history", changes: [], documentCount: rows.length };
  }

  const [newer, older] = rows;
  if (!isNormalizedDocumentShaped(newer.extracted_data) || !isNormalizedDocumentShaped(older.extracted_data)) {
    return { status: "malformed_history", changes: [], documentCount: rows.length };
  }

  const previousState = documentToCareState(older.extracted_data);
  const reconciliation = reconcileCareState(previousState, newer.extracted_data);
  const changes = summarizeReconciliation(reconciliation);

  return {
    status: changes.length > 0 ? "ok" : "no_changes",
    changes,
    documentCount: rows.length,
  };
}
