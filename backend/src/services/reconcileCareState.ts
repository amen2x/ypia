import type {
  Appointment,
  CareState,
  FollowUp,
  MedicationChange,
  MedicationChangeType,
  NormalizedDocument,
  NormalizedMedication,
  ReconciliationResult,
} from "../types.js";

const actionableMedicationChangeTypes = new Set<MedicationChangeType>([
  "ADDED",
  "DOSE_CHANGED",
  "FREQUENCY_CHANGED",
  "DOSE_AND_FREQUENCY_CHANGED",
  "STOPPED",
]);

function normalizeText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || null;
}

function hasValue(value: string | null): value is string {
  return normalizeText(value) !== null;
}

function medicationsMatch(
  current: NormalizedMedication,
  incoming: NormalizedMedication,
): boolean {
  const currentRxcui = normalizeText(current.rxnorm.rxcui);
  const incomingRxcui = normalizeText(incoming.rxnorm.rxcui);

  if (currentRxcui !== null && incomingRxcui !== null) {
    return currentRxcui === incomingRxcui;
  }

  const currentName = normalizeText(current.rxnorm.normalizedName ?? current.name);
  const incomingName = normalizeText(incoming.rxnorm.normalizedName ?? incoming.name);
  return currentName !== null && currentName === incomingName;
}

function findMatchingMedication(
  medications: NormalizedMedication[],
  incoming: NormalizedMedication,
): NormalizedMedication | undefined {
  return medications.find((medication) => medicationsMatch(medication, incoming));
}

function fieldChanged(previous: string | null, incoming: string | null): boolean {
  return hasValue(incoming) && normalizeText(previous) !== normalizeText(incoming);
}

function medicationChangeType(
  previous: NormalizedMedication,
  incoming: NormalizedMedication,
): MedicationChangeType | null {
  const doseChanged = fieldChanged(previous.dose, incoming.dose);
  const frequencyChanged = fieldChanged(previous.frequency, incoming.frequency);

  if (doseChanged && frequencyChanged) {
    return "DOSE_AND_FREQUENCY_CHANGED";
  }
  if (doseChanged) {
    return "DOSE_CHANGED";
  }
  if (frequencyChanged) {
    return "FREQUENCY_CHANGED";
  }
  return null;
}

function buildMedicationChange(
  type: MedicationChangeType,
  sourceMedication: NormalizedMedication,
  previous?: NormalizedMedication,
): MedicationChange {
  return {
    type,
    medicationName: sourceMedication.name,
    rxcui: sourceMedication.rxnorm.rxcui,
    previousDose: previous?.dose ?? null,
    newDose: sourceMedication.dose,
    previousFrequency: previous?.frequency ?? null,
    newFrequency: sourceMedication.frequency,
    sourceMedication: cloneMedication(sourceMedication),
  };
}

function cloneMedication(medication: NormalizedMedication): NormalizedMedication {
  return { ...medication, rxnorm: { ...medication.rxnorm } };
}

function cloneAppointment(appointment: Appointment): Appointment {
  return { ...appointment };
}

function cloneFollowUp(followUp: FollowUp): FollowUp {
  return { ...followUp };
}

function appointmentsMatch(current: Appointment, incoming: Appointment): boolean {
  const identifyingFields: Array<keyof Appointment> = ["type", "provider", "date", "time"];
  const fields: Array<keyof Appointment> = [...identifyingFields, "location"];
  let matchingFields = 0;

  for (const field of fields) {
    const currentValue = normalizeText(current[field]);
    const incomingValue = normalizeText(incoming[field]);

    if (currentValue !== null && incomingValue !== null) {
      if (currentValue !== incomingValue) {
        return false;
      }
      if (identifyingFields.includes(field)) {
        matchingFields += 1;
      }
    }
  }

  return matchingFields >= 2;
}

function followUpsMatch(current: FollowUp, incoming: FollowUp): boolean {
  return (
    normalizeText(current.description) === normalizeText(incoming.description) &&
    normalizeText(current.timeframe) === normalizeText(incoming.timeframe)
  );
}

function cloneCareState(state: CareState): CareState {
  return {
    medications: state.medications.map(cloneMedication),
    appointments: state.appointments.map(cloneAppointment),
    followUps: state.followUps.map(cloneFollowUp),
    instructions: [...state.instructions],
  };
}

export function reconcileCareState(
  previousState: CareState,
  newDocument: NormalizedDocument,
): ReconciliationResult {
  const medicationChanges: MedicationChange[] = [];

  for (const incoming of newDocument.medications) {
    const current = findMatchingMedication(previousState.medications, incoming);

    if (incoming.status === "started") {
      if (!current) {
        medicationChanges.push(buildMedicationChange("ADDED", incoming));
        continue;
      }

      const type = medicationChangeType(current, incoming);
      if (type) {
        medicationChanges.push(buildMedicationChange(type, incoming, current));
      }
      continue;
    }

    if (incoming.status === "changed") {
      if (!current) {
        medicationChanges.push(buildMedicationChange("CONFLICTING", incoming));
        continue;
      }

      const type = medicationChangeType(current, incoming);
      if (type) {
        medicationChanges.push(buildMedicationChange(type, incoming, current));
      }
      continue;
    }

    if (incoming.status === "stopped") {
      medicationChanges.push(
        buildMedicationChange(current ? "STOPPED" : "CONFLICTING", incoming, current),
      );
      continue;
    }

    if (!current) {
      if (incoming.status === "active") {
        medicationChanges.push(buildMedicationChange("CONFLICTING", incoming));
      }
      continue;
    }

    if (medicationChangeType(current, incoming)) {
      medicationChanges.push(buildMedicationChange("CONFLICTING", incoming, current));
    }
  }

  const newAppointments: Appointment[] = [];
  for (const incoming of newDocument.appointments) {
    const alreadyKnown = previousState.appointments.some((current) =>
      appointmentsMatch(current, incoming),
    );
    const alreadyAdded = newAppointments.some((current) => appointmentsMatch(current, incoming));
    if (!alreadyKnown && !alreadyAdded) {
      newAppointments.push(cloneAppointment(incoming));
    }
  }

  const newFollowUps: FollowUp[] = [];
  for (const incoming of newDocument.followUps) {
    const alreadyKnown = previousState.followUps.some((current) =>
      followUpsMatch(current, incoming),
    );
    const alreadyAdded = newFollowUps.some((current) => followUpsMatch(current, incoming));
    if (!alreadyKnown && !alreadyAdded) {
      newFollowUps.push(cloneFollowUp(incoming));
    }
  }

  const newInstructions: string[] = [];
  for (const incoming of newDocument.instructions) {
    const normalizedIncoming = normalizeText(incoming);
    const alreadyKnown = previousState.instructions.some(
      (current) => normalizeText(current) === normalizedIncoming,
    );
    const alreadyAdded = newInstructions.some(
      (current) => normalizeText(current) === normalizedIncoming,
    );
    if (normalizedIncoming !== null && !alreadyKnown && !alreadyAdded) {
      newInstructions.push(incoming);
    }
  }

  return {
    hasChanges:
      medicationChanges.some((change) => actionableMedicationChangeTypes.has(change.type)) ||
      newAppointments.length > 0 ||
      newFollowUps.length > 0 ||
      newInstructions.length > 0,
    medicationChanges,
    newAppointments,
    newFollowUps,
    newInstructions,
  };
}

export function applyReconciliation(
  previousState: CareState,
  reconciliation: ReconciliationResult,
): CareState {
  const nextState = cloneCareState(previousState);

  for (const change of reconciliation.medicationChanges) {
    if (!actionableMedicationChangeTypes.has(change.type)) {
      continue;
    }

    if (change.type === "ADDED") {
      if (!findMatchingMedication(nextState.medications, change.sourceMedication)) {
        nextState.medications.push(cloneMedication(change.sourceMedication));
      }
      continue;
    }

    const index = nextState.medications.findIndex((medication) =>
      medicationsMatch(medication, change.sourceMedication),
    );
    if (index === -1) {
      continue;
    }

    if (change.type === "STOPPED") {
      nextState.medications.splice(index, 1);
      continue;
    }

    const current = nextState.medications[index];
    nextState.medications[index] = {
      ...current,
      dose:
        change.type === "DOSE_CHANGED" || change.type === "DOSE_AND_FREQUENCY_CHANGED"
          ? change.newDose
          : current.dose,
      frequency:
        change.type === "FREQUENCY_CHANGED" ||
        change.type === "DOSE_AND_FREQUENCY_CHANGED"
          ? change.newFrequency
          : current.frequency,
    };
  }

  nextState.appointments.push(...reconciliation.newAppointments.map(cloneAppointment));
  nextState.followUps.push(...reconciliation.newFollowUps.map(cloneFollowUp));
  nextState.instructions.push(...reconciliation.newInstructions);

  return nextState;
}
