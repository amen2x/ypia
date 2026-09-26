import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSample = path.resolve(currentDirectory, "../samples/sample-prescription.json");
const samplePath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultSample;

async function run(): Promise<void> {
  const document = await extractDocument(samplePath);
  const normalizedDocument = await normalizeMedications(document);
  console.log(JSON.stringify(normalizedDocument, null, 2));
}

run().catch((error: unknown) => {
  console.error("Pipeline failed:", error);
  process.exitCode = 1;
});
