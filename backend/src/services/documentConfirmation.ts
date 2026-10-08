import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";
import { getParentIdForUser } from "./parentInfo.js";
import { normalizeMedications } from "./normalizeMedications.js";
import { extractedDocumentSchema } from "../schemas.js";
import {
  actionableMedicationChangeTypes,
  appointmentsMatch,
  findMatchingMedication,
  medicationsMatch,
  reconcileCareState,
} from "./reconcileCareState.js";
import { summarizeReconciliation, type ChangeSummary } from "./documentHistory.js";
import type {
  Appointment,
  CareState,
  DocumentType,
  ExtractedDocument,
  MedicationChange,
  NormalizedDocument,
  NormalizedMedication,
} from "../types.js";

export class DocumentAccessError extends Error {}
export class DocumentValidationError extends Error {}
export class DocumentNotConfirmableError extends Error {}

const CONFIRMABLE_STATUSES = new Set(["uploaded", "needs_confirmation"]);
const FALLBACK_TIMEZONE = "America/Chicago";

// parseAppointmentDateTime interprets free-text date/time using the server's own
// local timezone (there is no per-document timezone to parse against), so the
// timezone recorded alongside a new appointment must reflect that, not a hardcoded
// label that could silently mismatch the timestamp on a differently-configured host.
function currentSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  prescription: "Prescription",
  after_visit_summary: "Visit Summary",
  appointment_letter: "Appointment Letter",
  lab_result: "Lab Result",
  other: "Document",
};

const MEDICATION_STATUS_LABELS: Record<string, string> = {
  started: "Newly started",
  stopped: "Discontinued",
  changed: "Dose or frequency changed",
  active: "Currently active",
  unknown: "Not specified in document",
};

export interface ReviewMedication {
  name: string;
  dose: string | null;
  frequency: string | null;
  status: string;
  statusLabel: string;
}

export interface ReviewAppointment {
  type: string | null;
  provider: string | null;
  date: string | null;
  time: string | null;
  location: string | null;
}

export interface ReviewFollowUp {
  description: string;
  timeframe: string | null;
}

export interface DocumentReviewPayload {
  documentType: DocumentType;
  documentTypeLabel: string;
  medications: ReviewMedication[];
  appointments: ReviewAppointment[];
  followUps: ReviewFollowUp[];
  instructions: string[];
  isEmpty: boolean;
}

export function buildReviewPayload(document: ExtractedDocument): DocumentReviewPayload {
  const medications = document.medications.map((medication) => ({
    name: medication.name,
    dose: medication.dose,
    frequency: medication.frequency,
    status: medication.status,
    statusLabel: MEDICATION_STATUS_LABELS[medication.status] ?? "Not specified in document",
  }));

  return {
    documentType: document.documentType,
    documentTypeLabel: DOCUMENT_TYPE_LABELS[document.documentType] ?? "Document",
    medications,
    appointments: document.appointments.map((appointment) => ({ ...appointment })),
    followUps: document.followUps.map((followUp) => ({ ...followUp })),
    instructions: [...document.instructions],
    isEmpty:
      medications.length === 0 &&
      document.appointments.length === 0 &&
      document.followUps.length === 0 &&
      document.instructions.length === 0,
  };
}

interface DocumentRow {
  id: string;
  parent_id: string;
  document_name: string;
  status: string;
}

async function resolveParentIdOrThrow(userId: string): Promise<string> {
  const parentId = await getParentIdForUser(userId);
  if (!parentId) {
    throw new DocumentAccessError("Document not found");
  }
  return parentId;
}

export interface ConfirmDocumentInput {
  documentId: string;
  userId: string;
  editedData: unknown;
}

export interface ConfirmDocumentResult {
  status: "confirmed" | "already_confirmed";
  documentName: string;
  hasChanges: boolean;
  summary: ChangeSummary[];
  // Things in the document that were deliberately NOT applied to the care record because the
  // document alone doesn't settle them (conflicting or unclear details).
  notChanged: ChangeSummary[];
}

// Appointments require an explicit date and time. Unparseable or incomplete
// values stay in the reviewed document for correction, never become a guessed time.
export function parseAppointmentDateTime(date: string | null, time: string | null): Date | null {
  if (!date?.trim() || !time?.trim()) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date.trim());
  const named = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(date.trim());
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const year = Number(iso?.[1] ?? numeric?.[3] ?? named?.[3]);
  const month = iso ? Number(iso[2]) : numeric ? Number(numeric[1]) :
    months.findIndex((name) => name === named?.[1].toLowerCase() || name.slice(0, 3) === named?.[1].toLowerCase()) + 1;
  const day = Number(iso?.[3] ?? numeric?.[2] ?? named?.[2]);
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const clock = /^(\d{1,2}):([0-5]\d)(?:\s*(AM|PM))?$/i.exec(time.trim());
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (clock[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (clock[3].toUpperCase() === "PM" ? 12 : 0);
  } else if (hour > 23) return null;

  const parsed = new Date(0);
  parsed.setFullYear(year, month - 1, day);
  parsed.setHours(hour, minute, 0, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day ||
      parsed.getHours() !== hour || parsed.getMinutes() !== minute) return null;
  return parsed;
}

interface StoredMedication {
  dbId: string;
  medication: NormalizedMedication;
}

type QueryableClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

async function loadPreviousCareState(
  client: QueryableClient,
  parentId: string,
): Promise<{ careState: CareState; medicationRows: StoredMedication[] }> {
  const medicationsResult = await client.query(
    `SELECT id, drug_name, strength, dose_instructions, rxnorm_code
     FROM medications
     WHERE parent_id = $1 AND status = 'active'`,
    [parentId],
  );

  const medicationRows: StoredMedication[] = medicationsResult.rows.map((row) => ({
    dbId: row.id as string,
    medication: {
      name: row.drug_name as string,
      dose: (row.strength as string | null) ?? null,
      frequency: (row.dose_instructions as string | null) ?? null,
      status: "active",
      rxnorm: { rxcui: (row.rxnorm_code as string | null) ?? null, normalizedName: null },
    },
  }));

  const appointmentsResult = await client.query(
    `SELECT title, starts_at, timezone, clinic, location, provider_name
     FROM appointments
     WHERE parent_id = $1 AND status = 'confirmed'`,
    [parentId],
  );

  // Extraction gives free-text date/time (e.g. "October 14, 2026" / "10:30 AM"), so a
  // stored appointment must be reformatted the same way — an ISO timestamp here would
  // never text-match a freshly extracted appointment and would always look "new".
  const appointments: Appointment[] = appointmentsResult.rows.map((row) => {
    const timeZone = (row.timezone as string | null) || FALLBACK_TIMEZONE;
    const startsAt = row.starts_at ? new Date(row.starts_at as string | number | Date) : null;
    return {
      type: (row.title as string | null) ?? null,
      provider: (row.provider_name as string | null) ?? null,
      date: startsAt ? startsAt.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "long", day: "numeric" }) : null,
      time: startsAt ? startsAt.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }) : null,
      location: (row.location as string | null) ?? (row.clinic as string | null) ?? null,
    };
  });

  return {
    careState: {
      medications: medicationRows.map((row) => row.medication),
      appointments,
      followUps: [],
      instructions: [],
    },
    medicationRows,
  };
}

async function applyMedicationChange(
  client: QueryableClient,
  change: MedicationChange,
  medicationRows: StoredMedication[],
  parentId: string,
  documentId: string,
  confirmedBy: string,
): Promise<void> {
  if (change.type === "ADDED") {
    await client.query(
      `INSERT INTO medications
         (id, parent_id, drug_name, strength, dose_instructions, rxnorm_code, status, source_document_id, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, now())`,
      [
        randomUUID(),
        parentId,
        change.sourceMedication.name,
        change.newDose,
        change.newFrequency ?? "As directed",
        change.rxcui,
        documentId,
        confirmedBy,
      ],
    );
    return;
  }

  const matchedRow = medicationRows.find((row) => medicationsMatch(row.medication, change.sourceMedication));
  if (!matchedRow) return;
  const dbId = matchedRow.dbId;

  if (change.type === "STOPPED") {
    await client.query(`UPDATE medications SET status = 'stopped' WHERE id = $1 AND parent_id = $2`, [
      dbId,
      parentId,
    ]);
    return;
  }

  // Dose/frequency changes are recorded as a new row linked back to the superseded
  // one, mirroring the confirmed_by/confirmed_at provenance every row already carries.
  await client.query(`UPDATE medications SET status = 'completed' WHERE id = $1 AND parent_id = $2`, [
    dbId,
    parentId,
  ]);

  const nextDose =
    change.type === "DOSE_CHANGED" || change.type === "DOSE_AND_FREQUENCY_CHANGED"
      ? change.newDose
      : change.previousDose;
  const nextFrequency =
    change.type === "FREQUENCY_CHANGED" || change.type === "DOSE_AND_FREQUENCY_CHANGED"
      ? change.newFrequency
      : change.previousFrequency;

  await client.query(
    `INSERT INTO medications
       (id, parent_id, drug_name, strength, dose_instructions, rxnorm_code, status, source_document_id, confirmed_by, confirmed_at, replaces_medication_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, now(), $9)`,
    [
      randomUUID(),
      parentId,
      change.sourceMedication.name,
      nextDose,
      nextFrequency ?? "As directed",
      change.rxcui,
      documentId,
      confirmedBy,
      dbId,
    ],
  );
}

export interface ReviewNote {
  kind: "dose_differs" | "not_in_record" | "no_exact_time";
  message: string;
}

function sameText(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === (b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Plain-language heads-ups shown beside the review, computed against what the parent has
// already confirmed. They only explain; nothing here changes any record.
export async function buildReviewNotes(parentId: string, document: NormalizedDocument): Promise<ReviewNote[]> {
  const { careState } = await loadPreviousCareState(getPool() as unknown as QueryableClient, parentId);
  const notes: ReviewNote[] = [];

  for (const incoming of document.medications) {
    const current = findMatchingMedication(careState.medications, incoming);
    if (current) {
      if (incoming.dose && !sameText(current.dose, incoming.dose)) {
        notes.push({
          kind: "dose_differs",
          message: `${incoming.name}: your care record lists ${current.dose ?? "no dose"}, and this document says ${incoming.dose}. Your record only changes if the status below is "Dose or frequency changed".`,
        });
      }
    } else if (incoming.status !== "started") {
      notes.push({
        kind: "not_in_record",
        message: `${incoming.name} isn't in your care record yet. A medication in a document is only added when its status is "Newly started".`,
      });
    }
  }

  for (const appointment of document.appointments) {
    if (parseAppointmentDateTime(appointment.date, appointment.time)) continue;
    const label = [appointment.type, appointment.provider].filter(Boolean).join(" with ") || "An appointment";
    notes.push({
      kind: "no_exact_time",
      message: `${label} has no exact date and time, so it won't be added to your schedule. Add both if you know them.`,
    });
  }

  return notes;
}

export async function confirmDocument(input: ConfirmDocumentInput): Promise<ConfirmDocumentResult> {
  const parsed = extractedDocumentSchema.safeParse(input.editedData);
  if (!parsed.success) {
    throw new DocumentValidationError("The edited document information is not valid");
  }

  const parentId = await resolveParentIdOrThrow(input.userId);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const docResult = await client.query<DocumentRow>(
      `SELECT id, parent_id, document_name, status
       FROM documents
       WHERE id = $1 AND parent_id = $2
       FOR UPDATE`,
      [input.documentId, parentId],
    );
    const documentRow = docResult.rows[0];
    if (!documentRow) {
      throw new DocumentAccessError("Document not found");
    }

    if (documentRow.status === "confirmed") {
      await client.query("COMMIT");
      return {
        status: "already_confirmed",
        documentName: documentRow.document_name,
        hasChanges: false,
        summary: [],
        notChanged: [],
      };
    }

    if (!CONFIRMABLE_STATUSES.has(documentRow.status)) {
      throw new DocumentNotConfirmableError("This document cannot be confirmed right now");
    }

    const normalizedEditedDocument = await normalizeMedications(parsed.data);
    const { careState: previousState, medicationRows } = await loadPreviousCareState(client, parentId);
    const reconciliation = reconcileCareState(previousState, normalizedEditedDocument);

    for (const change of reconciliation.medicationChanges) {
      if (!actionableMedicationChangeTypes.has(change.type)) continue;
      await applyMedicationChange(client, change, medicationRows, parentId, input.documentId, input.userId);
    }

    const skippedAppointments: ChangeSummary[] = [];
    const addedAppointments: Appointment[] = [];
    for (const appointment of reconciliation.newAppointments) {
      const startsAt = parseAppointmentDateTime(appointment.date, appointment.time);
      const label = [appointment.type, appointment.provider].filter(Boolean).join(" with ") || "New appointment";

      if (!startsAt) {
        skippedAppointments.push({
          type: "appointment_needs_review",
          summary: `${label} was recorded, but the date/time could not be confirmed automatically — please check it.`,
        });
        continue;
      }

      const alreadyExists = previousState.appointments.some((existing) => appointmentsMatch(existing, appointment));
      if (alreadyExists) continue;

      await client.query(
        `INSERT INTO appointments
           (id, parent_id, title, starts_at, timezone, clinic, provider_name, location, status, created_by, source_document_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, $10)`,
        [
          randomUUID(),
          parentId,
          appointment.type ?? "Appointment",
          startsAt.toISOString(),
          currentSystemTimezone(),
          null,
          appointment.provider,
          appointment.location,
          input.userId,
          input.documentId,
        ],
      );
      addedAppointments.push(appointment);
    }

    await client.query(
      `UPDATE documents
       SET status = 'confirmed', reviewed_data = $3::jsonb, reviewed_by = $4, reviewed_at = now()
       WHERE id = $1 AND parent_id = $2`,
      [input.documentId, parentId, JSON.stringify(normalizedEditedDocument), input.userId],
    );

    await client.query("COMMIT");

    const summary = [...summarizeReconciliation({ ...reconciliation, newAppointments: addedAppointments }), ...skippedAppointments];
    const notChanged = reconciliation.medicationChanges
      .filter((change) => change.type === "CONFLICTING")
      .map((change) => ({
        type: "medication_not_changed",
        summary: `${change.medicationName} was left as it is in the care record. This document doesn't clearly say it started, changed or stopped, so nothing was changed.`,
      }));

    return {
      status: "confirmed",
      documentName: documentRow.document_name,
      hasChanges: reconciliation.hasChanges || skippedAppointments.length > 0,
      summary,
      notChanged,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
