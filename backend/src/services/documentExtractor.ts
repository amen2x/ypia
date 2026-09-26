import { readFile } from "node:fs/promises";
import { extractedDocumentSchema } from "../schemas.js";
import type { ExtractedDocument } from "../types.js";

export async function extractDocument(filePath: string): Promise<ExtractedDocument> {
  const contents = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(contents);
  return extractedDocumentSchema.parse(parsed);
}
