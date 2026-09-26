import assert from "node:assert/strict";
import {
  applyReconciliation,
  reconcileCareState,
} from "./services/reconcileCareState.js";
import type {
  CareState,
  NormalizedDocument,
  NormalizedMedication,
} from "./types.js";

function medication(overrides: Partial<NormalizedMedication> = {}): NormalizedMedication {
  const { rxnorm: rxnormOverrides, ...medicationOverrides } = overrides;

  return {
    name: "Lisinopril",
    dose: "10 mg",
    frequency: "once daily",
    status: "active",
    ...medicationOverrides,
    rxnorm: { rxcui: "29046", normalizedName: "lisinopril", ...rxnormOverrides },
  };
}

function state(medications: NormalizedMedication[] = [medication()]): CareState {
  return { medications, appointments: [], followUps: [], instructions: [] };
}

function document(
  medications: NormalizedMedication[] = [],
  overrides: Partial<NormalizedDocument> = {},
): NormalizedDocument {
  return {
    documentType: "after_visit_summary",
    medications,
    appointments: [],
    followUps: [],
    instructions: [],
    ...overrides,
  };
}

function test(name: string, run: () => void): void {
  run();
  console.log(`passed: ${name}`);
}

test("identical changed medication produces no change", () => {
  const result = reconcileCareState(state(), document([medication({ status: "changed" })]));
  assert.equal(result.medicationChanges.length, 0);
  assert.equal(result.hasChanges, false);
});

test("dose change is detected", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ dose: "20 mg", status: "changed" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "DOSE_CHANGED");
});

test("frequency change is detected", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ frequency: "twice daily", status: "changed" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "FREQUENCY_CHANGED");
});

test("combined dose and frequency change is detected", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ dose: "20 mg", frequency: "twice daily", status: "changed" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "DOSE_AND_FREQUENCY_CHANGED");
});

test("unmatched started medication is added", () => {
  const metoprolol = medication({
    name: "Metoprolol",
    status: "started",
    rxnorm: { rxcui: "6918", normalizedName: "metoprolol" },
  });
  const result = reconcileCareState(state(), document([metoprolol]));
  assert.equal(result.medicationChanges[0]?.type, "ADDED");
  assert.equal(applyReconciliation(state(), result).medications.length, 2);
});

test("medications absent from a document are preserved", () => {
  const previous = state();
  assert.deepEqual(applyReconciliation(previous, reconcileCareState(previous, document())), previous);
});

test("unmatched unknown medication does not create an addition", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ name: "Metoprolol", status: "unknown", rxnorm: { rxcui: "6918", normalizedName: "metoprolol" } })]),
  );
  assert.equal(result.medicationChanges.length, 0);
});

test("unknown conflicting details leave state unchanged", () => {
  const previous = state();
  const result = reconcileCareState(
    previous,
    document([medication({ dose: "20 mg", status: "unknown" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "CONFLICTING");
  assert.deepEqual(applyReconciliation(previous, result), previous);
});

test("active conflicting details leave state unchanged", () => {
  const previous = state();
  const result = reconcileCareState(
    previous,
    document([medication({ dose: "20 mg", status: "active" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "CONFLICTING");
  assert.deepEqual(applyReconciliation(previous, result), previous);
});

test("stopped medication is removed", () => {
  const previous = state();
  const result = reconcileCareState(previous, document([medication({ status: "stopped" })]));
  assert.equal(result.medicationChanges[0]?.type, "STOPPED");
  assert.equal(applyReconciliation(previous, result).medications.length, 0);
});

test("unknown stopped medication is conflicting", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ name: "Metoprolol", status: "stopped", rxnorm: { rxcui: "6918", normalizedName: "metoprolol" } })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "CONFLICTING");
});

test("name matching works when one medication has no RxCUI", () => {
  const previous = state([medication({ rxnorm: { rxcui: null, normalizedName: "lisinopril" } })]);
  const result = reconcileCareState(
    previous,
    document([medication({ dose: "20 mg", status: "changed" })]),
  );
  assert.equal(result.medicationChanges[0]?.type, "DOSE_CHANGED");
});

test("missing new dose does not create a dose change", () => {
  const result = reconcileCareState(
    state(),
    document([medication({ dose: null, status: "changed" })]),
  );
  assert.equal(result.medicationChanges.length, 0);
});

test("duplicate appointment is ignored even when the new copy adds a location", () => {
  const previous = state();
  previous.appointments.push({
    type: "Cardiology follow-up",
    provider: "Dr. Avery Chen",
    date: "2026-10-14",
    time: "2:30 PM",
    location: null,
  });
  const result = reconcileCareState(
    previous,
    document([], {
      appointments: [{
        type: "Cardiology follow-up",
        provider: "Dr. Avery Chen",
        date: "2026-10-14",
        time: "2:30 PM",
        location: "Northside Cardiology Clinic",
      }],
    }),
  );
  assert.equal(result.newAppointments.length, 0);
});

test("a distinct appointment is added once when repeated in a document", () => {
  const appointment = {
    type: "Cardiology",
    provider: "Dr. Chen",
    date: "2026-10-14",
    time: "2:30 PM",
    location: null,
  };
  const result = reconcileCareState(
    state(),
    document([], {
      appointments: [appointment, appointment],
    }),
  );
  assert.equal(result.newAppointments.length, 1);
});

test("new follow-up is detected and duplicate follow-up is ignored", () => {
  const previous = state();
  previous.followUps.push({ description: "Follow up with Cardiology", timeframe: "within 7 days" });
  const duplicate = reconcileCareState(
    previous,
    document([], { followUps: [{ description: " follow up with cardiology ", timeframe: "within 7 days" }] }),
  );
  const added = reconcileCareState(
    previous,
    document([], { followUps: [{ description: "Follow up with primary care", timeframe: "within 14 days" }] }),
  );
  assert.equal(duplicate.newFollowUps.length, 0);
  assert.equal(added.newFollowUps.length, 1);
});

test("duplicate instruction is ignored", () => {
  const previous = state();
  previous.instructions.push("Monitor blood pressure daily");
  const result = reconcileCareState(
    previous,
    document([], { instructions: [" monitor   blood pressure daily "] }),
  );
  assert.equal(result.newInstructions.length, 0);
});

test("reconciliation does not mutate its inputs", () => {
  const previous = state();
  const incoming = document([medication({ dose: "20 mg", status: "changed" })]);
  const previousSnapshot = structuredClone(previous);
  const incomingSnapshot = structuredClone(incoming);
  reconcileCareState(previous, incoming);
  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(incoming, incomingSnapshot);
});

test("reconciling after application is idempotent", () => {
  const previous = state();
  const incoming = document([
    medication({ dose: "20 mg", status: "changed" }),
    medication({ name: "Metoprolol", status: "started", rxnorm: { rxcui: "6918", normalizedName: "metoprolol" } }),
  ], { instructions: ["Monitor blood pressure daily"] });
  const first = reconcileCareState(previous, incoming);
  const applied = applyReconciliation(previous, first);
  const second = reconcileCareState(applied, incoming);
  assert.equal(second.hasChanges, false);
  assert.equal(second.medicationChanges.length, 0);
  assert.equal(second.newInstructions.length, 0);
});

test("TigerHacks after-visit example creates the expected care state", () => {
  const previous = state([
    medication({ dose: "10 mg" }),
    medication({
      name: "Atorvastatin",
      dose: "40 mg",
      status: "active",
      rxnorm: { rxcui: "83367", normalizedName: "atorvastatin" },
    }),
  ]);
  previous.appointments.push({
    type: "Primary care",
    provider: "Dr. Morgan Lee",
    date: "2026-10-01",
    time: "9:00 AM",
    location: "Community Health Center",
  });
  previous.followUps.push({ description: "Annual wellness visit", timeframe: "within 12 months" });
  previous.instructions.push("Continue a heart-healthy diet");
  const afterVisit = document([
    medication({ dose: "20 mg", status: "changed" }),
    medication({ name: "Metoprolol", dose: "25 mg", status: "started", rxnorm: { rxcui: "6918", normalizedName: "metoprolol" } }),
  ], {
    appointments: [{
      type: "Cardiology Follow-Up",
      provider: "Dr. Avery Chen",
      date: "October 14, 2026",
      time: "2:30 PM",
      location: "Northside Cardiology Clinic",
    }],
    followUps: [{ description: "Follow up with Cardiology", timeframe: "within 7 days" }],
    instructions: ["Monitor blood pressure daily"],
  });
  const result = reconcileCareState(previous, afterVisit);
  const applied = applyReconciliation(previous, result);
  assert.deepEqual(result.medicationChanges.map((change) => change.type), ["DOSE_CHANGED", "ADDED"]);
  assert.equal(applied.medications.find((item) => item.name === "Lisinopril")?.dose, "20 mg");
  assert.equal(applied.medications.find((item) => item.name === "Metoprolol")?.dose, "25 mg");
  assert.equal(applied.medications.find((item) => item.name === "Atorvastatin")?.dose, "40 mg");
  assert.equal(applied.appointments.length, 2);
  assert.equal(applied.followUps.length, 2);
  assert.equal(applied.instructions.length, 2);
});

console.log("All reconciliation tests passed.");
