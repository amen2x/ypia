import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractedDocumentSchema } from "../schemas.js";
import type { ExtractedDocument } from "../types.js";
import { extractWithGemini } from "./gemini.js";

const supportedMediaTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf"
};

async function extractJsonDocument(filePath: string): Promise<ExtractedDocument> {
  const contents = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return extractedDocumentSchema.parse(parsed);
}

export async function extractDocument(filePath: string): Promise<ExtractedDocument> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return extractJsonDocument(filePath);

  const mimeType = supportedMediaTypes[extension];
  if (mimeType) return extractWithGemini(filePath, mimeType);

  throw new Error(`Unsupported document type: ${extension || "no extension"}. Supported types: .json, .jpg, .jpeg, .png, .pdf`);
}
