import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";
import { createAccount, verifyLogin, AuthError } from "./services/auth.js";
<<<<<<< Updated upstream
import { getParentIdForUser, getNextAppointment, getCurrentMedications } from "./services/parentInfo.js";
import { DatabaseConfigurationError } from "./db.js";
import { signupSchema, loginSchema } from "./schemas.js";
=======
import { DatabaseConfigurationError, getPool } from "./db.js";
import { signupSchema, loginSchema, backgroundNotesSchema } from "./schemas.js";
>>>>>>> Stashed changes

const upload = multer({ storage: multer.memoryStorage() });
const backgroundUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [".txt", ".json", ".md", ".csv", ".text"];
    const allowedMimes = [
      "text/plain",
      "application/json",
      "text/markdown",
      "text/csv",
      "application/octet-stream",
      "text/x-markdown",
      ""
    ];
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only text or JSON files (.txt, .json, .md, .csv) are accepted"));
    }
  }
});
const ALLOWED_ORIGINS = [
  "http://localhost:5000",
  "http://127.0.0.1:5000",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

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

// Turns an uploaded background file into a clean readable text blob.
// .txt/.md are used as-is. .json handles strings, arrays, or objects (key: value).
function extractBackgroundText(file: Express.Multer.File): string {
  const raw = file.buffer.toString("utf-8");
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".json" || file.mimetype === "application/json") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed.trim();
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
          .filter(Boolean)
          .join("\n")
          .trim();
      }
      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed)
          .map(([k, v]) => {
            if (typeof v === "string") return `${k}: ${v}`;
            if (Array.isArray(v)) return `${k}: ${v.join(", ")}`;
            return `${k}: ${JSON.stringify(v)}`;
          })
          .join("\n")
          .trim();
      }
    } catch {
      return raw.trim();
    }
  }
  return raw.trim();
}

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof AuthError) {
    response.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof DatabaseConfigurationError) {
    // This used to log/return a misleading "auth service" message on every
    // route, including non-auth ones like /api/parents/:id. Log the real
    // cause and return an accurate message instead.
    console.error("Database configuration error:", error.message);
    response.status(500).json({ error: "Database is not configured on the server" });
    return;
  }

  // Previously this branch never logged anything, so a real Postgres
  // connection failure (wrong host, refused connection, SSL mismatch, etc.)
  // would silently turn into a generic 400 with no trace in the server logs.
  console.error("Unhandled request error:", error);

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

  // List all parents
  app.get("/api/parents", async (_request, response, next) => {
    try {
      const result = await getPool().query(
        `SELECT id, full_name AS name, background_notes FROM parents ORDER BY full_name ASC`
      );
      response.json(result.rows);
    } catch (error: unknown) {
      next(error);
    }
  });

  // Look up parent for a given user (auto-approves pending links and supports fallback)
  app.get("/api/users/:id/parent", async (request, response, next) => {
    try {
      const pool = getPool();
      // Check parent_relationships
      const relResult = await pool.query<{ parent_id: string; status: string }>(
        `SELECT parent_id, status FROM parent_relationships WHERE user_id = $1 LIMIT 1`,
        [request.params.id]
      );
      if (relResult.rows.length > 0) {
        const { parent_id: parentId, status } = relResult.rows[0];
        if (status === "pending") {
          await pool.query(
            `UPDATE parent_relationships SET status = 'approved' WHERE user_id = $1 AND parent_id = $2`,
            [request.params.id, parentId]
          );
        }
        const parentResult = await pool.query(
          `SELECT id, full_name AS name, background_notes FROM parents WHERE id = $1`,
          [parentId]
        );
        if (parentResult.rows.length > 0) {
          response.json({ parentId, parent: parentResult.rows[0] });
          return;
        }
      }

      // Check if user is themselves a parent
      const parentSelf = await pool.query(
        `SELECT id, full_name AS name, background_notes FROM parents WHERE user_id = $1 LIMIT 1`,
        [request.params.id]
      );
      if (parentSelf.rows.length > 0) {
        response.json({ parentId: parentSelf.rows[0].id, parent: parentSelf.rows[0] });
        return;
      }

      // Fallback to the first parent in the database
      const fallbackParent = await pool.query(
        `SELECT id, full_name AS name, background_notes FROM parents LIMIT 1`
      );
      if (fallbackParent.rows.length > 0) {
        response.json({ parentId: fallbackParent.rows[0].id, parent: fallbackParent.rows[0], fallback: true });
        return;
      }

      response.status(404).json({ error: "No parent found" });
    } catch (error: unknown) {
      next(error);
    }
  });

  // Fetch a parent's dashboard data (name + background notes) by parent id.
  app.get("/api/parents/:id", async (request, response, next) => {
    try {
      const result = await getPool().query(
        `SELECT id, full_name AS name, background_notes FROM parents WHERE id = $1`,
        [request.params.id]
      );
      if (result.rows.length === 0) {
        response.status(404).json({ error: "Parent not found" });
        return;
      }
      response.json(result.rows[0]);
    } catch (error: unknown) {
      next(error);
    }
  });

  // Update background notes from typed text (JSON body: { backgroundNotes }).
  app.put("/api/parents/:id/background", async (request, response, next) => {
    const parsed = backgroundNotesSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    try {
      await getPool().query(`UPDATE parents SET background_notes = $1 WHERE id = $2`, [
        parsed.data.backgroundNotes,
        request.params.id
      ]);
      response.json({ backgroundNotes: parsed.data.backgroundNotes });
    } catch (error: unknown) {
      next(error);
    }
  });

  // Update background notes from an uploaded .txt or .json file (multipart field "file").
  app.put(
    "/api/parents/:id/background/upload",
    backgroundUpload.single("file"),
    async (request, response, next) => {
      if (!request.file) {
        response.status(400).json({ error: "A .txt or .json file is required" });
        return;
      }

      try {
        const text = extractBackgroundText(request.file);
        await getPool().query(`UPDATE parents SET background_notes = $1 WHERE id = $2`, [
          text,
          request.params.id
        ]);
        response.json({ backgroundNotes: text });
      } catch (error: unknown) {
        next(error);
      }
    }
  );

  app.use(errorHandler);
  return app;
}