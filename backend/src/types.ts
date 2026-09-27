export type MedicationStatus = "active" | "started" | "stopped" | "changed" | "unknown";

export interface Medication {
  name: string;
  dose: string | null;
  frequency: string | null;
  status: MedicationStatus;
}

export interface Appointment {
  type: string | null;
  provider: string | null;
  date: string | null;
  time: string | null;
  location: string | null;
}

export interface FollowUp {
  description: string;
  timeframe: string | null;
}

// Must match the documents_document_type_check constraint in the database exactly.
export type DocumentType = "prescription" | "after_visit_summary" | "appointment_letter" | "lab_result" | "other";

export interface ExtractedDocument {
  documentType: DocumentType;
  medications: Medication[];
  appointments: Appointment[];
  followUps: FollowUp[];
  instructions: string[];
}

export interface RxNormMedication {
  originalName: string;
  rxcui: string | null;
  normalizedName: string | null;
}

export interface NormalizedMedication extends Medication {
  rxnorm: Pick<RxNormMedication, "rxcui" | "normalizedName">;
}

export interface NormalizedDocument extends Omit<ExtractedDocument, "medications"> {
  medications: NormalizedMedication[];
}

export interface CareState {
  medications: NormalizedMedication[];
  appointments: Appointment[];
  followUps: FollowUp[];
  instructions: string[];
}

export type MedicationChangeType =
  | "ADDED"
  | "DOSE_CHANGED"
  | "FREQUENCY_CHANGED"
  | "DOSE_AND_FREQUENCY_CHANGED"
  | "STOPPED"
  | "CONFLICTING";

export interface MedicationChange {
  type: MedicationChangeType;
  medicationName: string;
  rxcui: string | null;
  previousDose: string | null;
  newDose: string | null;
  previousFrequency: string | null;
  newFrequency: string | null;
  sourceMedication: NormalizedMedication;
}

export interface ReconciliationResult {
  hasChanges: boolean;
  medicationChanges: MedicationChange[];
  newAppointments: Appointment[];
  newFollowUps: FollowUp[];
  newInstructions: string[];
}

export interface CareUpdateResult {
  reconciliation: ReconciliationResult;
  nextState: CareState;
}
