import { normalizeMedication } from "./rxnorm.js";
import type { ExtractedDocument, NormalizedDocument } from "../types.js";

export async function normalizeMedications(document: ExtractedDocument): Promise<NormalizedDocument> {
  const medications = await Promise.all(
    document.medications.map(async (medication) => {
      const { rxcui, normalizedName } = await normalizeMedication(medication.name);
      return { ...medication, rxnorm: { rxcui, normalizedName } };
    })
  );

  return { ...document, medications };
}
