import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";
import { createAccount, verifyLogin, AuthError } from "./services/auth.js";
import { getParentIdForUser, getNextAppointment, getCurrentMedications } from "./services/parentInfo.js";
import { DatabaseConfigurationError } from "./db.js";
import { signupSchema, loginSchema } from "./schemas.js";
import { gameRoutes } from "./gameRoutes.js";

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

function parseUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGINS }));
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/elevenlabs/signed-url", async (_request, response) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey || !agentId) {
      response.status(500).json({ error: "ElevenLabs is not configured" });
      return;
    }

    try {
      const elevenLabsResponse = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey } }
      );

      if (!elevenLabsResponse.ok) {
        response.status(502).json({ error: "Could not start a voice session" });
        return;
      }

      const body = (await elevenLabsResponse.json()) as { signed_url?: string };
      if (!body.signed_url) {
        response.status(502).json({ error: "Could not start a voice session" });
        return;
      }

      response.json({ signedUrl: body.signed_url });
    } catch {
      response.status(502).json({ error: "Could not start a voice session" });
    }
  });

  app.get("/api/parent/next-appointment", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      const appointment = await getNextAppointment(parentId);
      response.json({ appointment });
    } catch (error: unknown) {
      console.error("Failed to load next appointment", error);
      response.status(500).json({ error: "Unable to load appointment information" });
    }
  });

  app.get("/api/parent/current-medications", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      const medications = await getCurrentMedications(parentId);
      response.json({ medications });
    } catch (error: unknown) {
      console.error("Failed to load current medications", error);
      response.status(500).json({ error: "Unable to load medication information" });
    }
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
  app.use(gameRoutes);
  app.use(errorHandler);
  return app;
}
