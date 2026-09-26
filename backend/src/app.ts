import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";
import { createAccount, verifyLogin, AuthError } from "./services/auth.js";
import { DatabaseConfigurationError } from "./db.js";
import { signupSchema, loginSchema } from "./schemas.js";

const upload = multer({ storage: multer.memoryStorage() });
const ALLOWED_ORIGINS = ["http://localhost:5000", "http://127.0.0.1:5000"];

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
  if (error instanceof AuthError) {
    response.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof DatabaseConfigurationError) {
    console.error("Database configuration unavailable for authentication request");
    response.status(500).json({ error: "Authentication service is temporarily unavailable" });
    return;
  }

  const message = error instanceof Error ? error.message : "Document processing failed";
  response.status(400).json({ error: message });
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGINS }));
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

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

  app.post("/api/signup", async (request, response, next) => {
    const parsed = signupSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    try {
      const { userId } = await createAccount(parsed.data);
      response.status(201).json({ userId });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/login", async (request, response, next) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    try {
      const user = await verifyLogin(parsed.data.email, parsed.data.password);
      response.json({ user });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.use(errorHandler);
  return app;
}
