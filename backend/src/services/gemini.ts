import { readFile } from "node:fs/promises";
import { createPartFromBase64, GoogleGenAI } from "@google/genai";
import { extractedDocumentSchema } from "../schemas.js";
import type { ExtractedDocument } from "../types.js";

const model = "gemini-3.8-flash";

const extractionPrompt = `Extract healthcare-document information that is visibly present in the supplied document.

You are an information extractor, not a medical advisor. Do not diagnose or recommend treatment. Do not infer medication changes unless the document explicitly indicates them. Do not identify medication from pill appearance alone. Do not invent missing dates, providers, doses, frequencies, or instructions. Use null when a field is unavailable, empty arrays when a category is absent, and "unknown" when medication status is unclear. Preserve medication names and dosage wording from the document. Classify documentType using only the allowed values in the response schema.`;

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

  try {
    const response = await new GoogleGenAI({ apiKey }).models.generateContent({
      model,
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
    if (error instanceof Error && error.message.startsWith("Gemini returned")) throw error;
    throw new Error(`Gemini extraction failed: ${sanitizeGeminiError(error, apiKey)}`);
  }
}
