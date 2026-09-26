import assert from "node:assert/strict";
import { processCareUpdate } from "./services/processCareUpdate.js";
import type { CareState, NormalizedDocument, NormalizedMedication } from "./types.js";

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

function document(medications: NormalizedMedication[] = []): NormalizedDocument {
  return {
    documentType: "after_visit_summary",
    medications,
    appointments: [],
    followUps: [],
    instructions: [],
  };
}

function test(name: string, run: () => void): void {
  run();
  console.log(`passed: ${name}`);
}

test("returns reconciliation and next state for a care update", () => {
  const previous = state([
    medication(),
    medication({
      name: "Atorvastatin",
      dose: "40 mg",
      rxnorm: { rxcui: "83367", normalizedName: "atorvastatin" },
    }),
  ]);
  const incoming = document([
    medication({ dose: "20 mg", status: "changed" }),
    medication({
      name: "Metoprolol",
      dose: "25 mg",
      status: "started",
      rxnorm: { rxcui: "6918", normalizedName: "metoprolol" },
    }),
  ]);
  incoming.followUps = [{ description: "Cardiology", timeframe: "within 7 days" }];
  incoming.instructions = ["Monitor blood pressure daily"];

  const update = processCareUpdate(previous, incoming);

  assert.deepEqual(update.reconciliation.medicationChanges.map((change) => change.type), [
    "DOSE_CHANGED",
    "ADDED",
  ]);
  assert.equal(update.reconciliation.newFollowUps.length, 1);
  assert.equal(update.reconciliation.newInstructions.length, 1);
  assert.equal(update.nextState.medications.find((item) => item.name === "Lisinopril")?.dose, "20 mg");
  assert.equal(update.nextState.medications.find((item) => item.name === "Atorvastatin")?.dose, "40 mg");
  assert.equal(update.nextState.medications.find((item) => item.name === "Metoprolol")?.dose, "25 mg");
});

test("preserves medications omitted from a document", () => {
  const previous = state();
  const update = processCareUpdate(previous, document());
  assert.deepEqual(update.nextState, previous);
});

test("removes only an explicitly stopped medication", () => {
  const previous = state();
  const update = processCareUpdate(previous, document([medication({ status: "stopped" })]));
  assert.equal(update.reconciliation.medicationChanges[0]?.type, "STOPPED");
  assert.equal(update.nextState.medications.length, 0);
});

test("does not add an unknown prescription medication", () => {
  const update = processCareUpdate(
    state(),
    document([
      medication({
        name: "Metoprolol",
        status: "unknown",
        rxnorm: { rxcui: "6918", normalizedName: "metoprolol" },
      }),
    ]),
  );
  assert.equal(update.reconciliation.medicationChanges.length, 0);
  assert.equal(update.nextState.medications.length, 1);
});

test("keeps the effective state unchanged when no action is needed", () => {
  const previous = state();
  const update = processCareUpdate(previous, document([medication({ status: "changed" })]));
  assert.equal(update.reconciliation.hasChanges, false);
  assert.deepEqual(update.nextState, previous);
});

test("is idempotent after applying the same document", () => {
  const previous = state();
  const incoming = document([
    medication({ dose: "20 mg", status: "changed" }),
    medication({
      name: "Metoprolol",
      dose: "25 mg",
      status: "started",
      rxnorm: { rxcui: "6918", normalizedName: "metoprolol" },
    }),
  ]);
  incoming.instructions = ["Monitor blood pressure daily"];

  const first = processCareUpdate(previous, incoming);
  const second = processCareUpdate(first.nextState, incoming);

  assert.equal(second.reconciliation.hasChanges, false);
  assert.equal(second.reconciliation.medicationChanges.length, 0);
  assert.equal(second.reconciliation.newInstructions.length, 0);
});

console.log("All care-update tests passed.");
