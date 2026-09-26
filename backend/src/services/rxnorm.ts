import type { RxNormMedication } from "../types.js";

const rxNormBaseUrl = "https://rxnav.nlm.nih.gov/REST";

interface RxCuiResponse {
  idGroup?: { rxnormId?: string[] };
}

interface PropertiesResponse {
  properties?: { name?: string };
}

async function fetchRxNorm<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${rxNormBaseUrl}${path}`);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function searchMedication(name: string): Promise<string[]> {
  const query = encodeURIComponent(name);
  const result = await fetchRxNorm<RxCuiResponse>(`/rxcui.json?name=${query}`);
  return result?.idGroup?.rxnormId?.filter((id) => typeof id === "string") ?? [];
}

async function getNormalizedName(rxcui: string): Promise<string | null> {
  const result = await fetchRxNorm<PropertiesResponse>(`/rxcui/${encodeURIComponent(rxcui)}/properties.json`);
  return typeof result?.properties?.name === "string" ? result.properties.name : null;
}

export async function normalizeMedication(name: string): Promise<RxNormMedication> {
  const rxcui = (await searchMedication(name))[0] ?? null;
  if (!rxcui) return { originalName: name, rxcui: null, normalizedName: null };

  return {
    originalName: name,
    rxcui,
    normalizedName: await getNormalizedName(rxcui)
  };
}
