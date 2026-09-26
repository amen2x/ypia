import { applyReconciliation, reconcileCareState } from "./reconcileCareState.js";
import type { CareState, CareUpdateResult, NormalizedDocument } from "../types.js";

export function processCareUpdate(
  previousState: CareState,
  newDocument: NormalizedDocument,
): CareUpdateResult {
  const reconciliation = reconcileCareState(previousState, newDocument);
  const nextState = applyReconciliation(previousState, reconciliation);

  return { reconciliation, nextState };
}
