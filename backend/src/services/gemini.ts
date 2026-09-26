import { readFile } from "node:fs/promises";
import { createPartFromBase64, GoogleGenAI } from "@google/genai";
import { extractedDocumentSchema } from "../schemas.js";
import type { ExtractedDocument } from "../types.js";

const models = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" }
] as const;
const maxAttempts = 3;

const extractionPrompt = `Extract healthcare-document information that is visibly present in the supplied document.

You are an information extractor, not a medical advisor. Do not diagnose or recommend treatment. Do not identify medication from pill appearance alone. Do not invent missing dates, providers, doses, frequencies, or instructions. Use null when a field is unavailable and empty arrays when a category is absent. Classify documentType using only the allowed values in the response schema.

Set medication status to "started" only when the document explicitly says start, begin, newly prescribed, or equivalent. Set it to "stopped" only for explicit stop or discontinue wording. Set it to "changed" only when the document explicitly says the dose or frequency changed. Set it to "active" only when the document explicitly identifies the medication as current, active, or continued. Otherwise use "unknown". A prescription bottle or label alone does not establish that a medication is active.

Extract the medication name without dosage-form words unless they are necessary to identify the drug. For example, extract "Amoxicillin" from "AMOXICILLIN 500 MG CAPSULE" and put "500 mg" in dose. Do not remove meaningful active ingredients from combination-drug names.`;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

const extractedDocumentJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentType: {
      type: "string",
      enum: ["prescription", "after_visit_summary", "discharge_summary", "appointment", "lab", "other"]
    },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          dose: nullableString,
          frequency: nullableString,
          status: { type: "string", enum: ["active", "started", "stopped", "changed", "unknown"] }
        },
        required: ["name", "dose", "frequency", "status"]
      }
    },
    appointments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: nullableString,
          provider: nullableString,
          date: nullableString,
          time: nullableString,
          location: nullableString
        },
        required: ["type", "provider", "date", "time", "location"]
      }
    },
    followUps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          timeframe: nullableString
        },
        required: ["description", "timeframe"]
      }
    },
    instructions: { type: "array", items: { type: "string" } }
  },
  required: ["documentType", "medications", "appointments", "followUps", "instructions"]
};

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  return apiKey;
}

function sanitizeGeminiError(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replaceAll(apiKey, "[redacted]").replaceAll(encodeURIComponent(apiKey), "[redacted]");
}

function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const { status } = error as { status?: unknown };
  return typeof status === "number" ? status : null;
}

function isTransientGeminiError(error: unknown): boolean {
  const status = getHttpStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function logGeminiFailure(
  model: (typeof models)[number],
  error: unknown,
  apiKey: string,
  nextModel?: (typeof models)[number],
): void {
  const status = getHttpStatus(error);
  const statusLabel = status === null ? "HTTP status unavailable" : `HTTP ${status}`;
  const destination = nextModel ? `trying ${nextModel.label}` : "not retrying";
  console.warn(
    `${model.label} failed (${statusLabel}): ${sanitizeGeminiError(error, apiKey)}; ${destination}`,
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseGeminiResponse(text: string | undefined): ExtractedDocument {
  if (!text) throw new Error("Gemini returned no extraction result");

  try {
    return extractedDocumentSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new Error("Gemini returned an invalid document extraction result");
  }
}

export async function extractWithGemini(filePath: string, mimeType: string): Promise<ExtractedDocument> {
  const fileData = await readFile(filePath);
  const apiKey = getGeminiApiKey();
  const client = new GoogleGenAI({ apiKey });
  let modelIndex = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const activeModel = models[modelIndex];

    try {
      const response = await client.models.generateContent({
        model: activeModel.id,
        contents: [{
          role: "user",
          parts: [
            { text: extractionPrompt },
            createPartFromBase64(fileData.toString("base64"), mimeType)
          ]
        }],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: extractedDocumentJsonSchema
        }
      });

      return parseGeminiResponse(response.text);
    } catch (error: unknown) {
      if (!isTransientGeminiError(error) || attempt === maxAttempts) {
        logGeminiFailure(activeModel, error, apiKey);
        if (error instanceof Error && error.message.startsWith("Gemini returned")) throw error;
        throw new Error(`Gemini extraction failed: ${sanitizeGeminiError(error, apiKey)}`);
      }

      const nextModel = models[modelIndex + 1];
      logGeminiFailure(activeModel, error, apiKey, nextModel);
      modelIndex += 1;
      await wait(attempt * 1000);
    }
  }

  throw new Error("Gemini extraction failed");
}
