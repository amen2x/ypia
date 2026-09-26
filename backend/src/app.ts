import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";

const upload = multer({ storage: multer.memoryStorage() });

async function processUpload(file: Express.Multer.File) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tigerhacks-document-"));
  const temporaryFile = path.join(temporaryDirectory, `upload${path.extname(file.originalname).toLowerCase()}`);

  try {
    await writeFile(temporaryFile, file.buffer);
    return normalizeMedications(await extractDocument(temporaryFile));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const message = error instanceof Error ? error.message : "Document processing failed";
  response.status(400).json({ error: message });
}

export function createApp() {
  const app = express();

  app.post("/api/documents", upload.single("document"), async (request, response, next) => {
    if (!request.file) {
      response.status(400).json({ error: "A document file is required" });
      return;
    }

    try {
      response.json(await processUpload(request.file));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.use(errorHandler);
  return app;
}
