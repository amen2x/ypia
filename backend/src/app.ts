import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { extractDocument } from "./services/documentExtractor.js";
import { normalizeMedications } from "./services/normalizeMedications.js";
import { createAccount, verifyLogin, AuthError } from "./services/auth.js";
import {
  getParentIdForUser,
  getNextAppointment,
  getCurrentMedications,
  getApprovedParentIdsForCaregiver,
} from "./services/parentInfo.js";
import { saveDocumentExtraction, getLatestChanges } from "./services/documentHistory.js";
import {
  buildReviewPayload,
  confirmDocument,
  DocumentAccessError,
  DocumentNotConfirmableError,
  DocumentValidationError,
} from "./services/documentConfirmation.js";
import {
  createCaregiverAction,
  listCaregiverActions,
  updateActionStatus,
  getActionConversation,
} from "./services/caregiverActions.js";
import { registerVoiceConversation, syncVoiceConversation } from "./services/voiceConversations.js";
import { listSharedDocuments } from "./services/caregiverDocuments.js";
import { checkInParent } from "./services/checkIns.js";
import { DatabaseConfigurationError, getPool } from "./db.js";
import { scoreUnreviewedSchedule } from "./services/schedulePoints.js";
import { signupSchema, loginSchema, backgroundNotesSchema } from "./schemas.js";
import { gameRoutes } from "./gameRoutes.js";
import { streakRoutes } from "./streakRoutes.js";
import { calendarRoutes } from "./calendarRoutes.js";

import { getParentBackground, isValidScheduleRange, resolveTimezone, getParentSchedule } from "./services/parentContext.js";


const MAX_ACTION_TEXT_LENGTH = 500;

function parseActionText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACTION_TEXT_LENGTH) return null;
  return trimmed;
}

function parseOptionalConversationId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

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
    console.error("Database configuration error:", error.message);
    response.status(500).json({ error: "Database is not configured on the server" });
    return;
  }

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
  app.use("/api/calendar", calendarRoutes);

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

  app.post("/api/parent/check-in", async (request, response) => {
    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    const activityNotes =
      parseActionText((request.body as Record<string, unknown> | undefined)?.activityNotes) ??
      "Activity check-in";

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

      const streak = await checkInParent(parentId, userId, activityNotes);
      response.json({ status: "ok", streak });
    } catch (error: unknown) {
      console.error("Failed to check in parent", error);
      response.status(500).json({ error: "Unable to record check-in" });
    }
  });

  app.post("/api/documents", upload.single("document"), async (request, response, next) => {
    if (!request.file) {
      response.status(400).json({ error: "A document file is required" });
      return;
    }

    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    let parentId: string | null = null;

    if (userId) {
      try {
        parentId = await getParentIdForUser(userId);
      } catch (error: unknown) {
        next(error);
        return;
      }

      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }
    }

    try {
      const extracted = await processUpload(request.file);
      let documentId: string | null = null;

      if (userId && parentId) {
        try {
          documentId = await saveDocumentExtraction({
            parentId,
            uploadedBy: userId,
            documentName: request.file.originalname,
            mimeType: request.file.mimetype,
            fileSizeBytes: request.file.size,
            extractedData: extracted,
          });
        } catch (persistError: unknown) {
          console.error("Failed to persist document extraction", persistError);
          response.status(500).json({ error: "Document was processed but could not be saved" });
          return;
        }
      }

      // The caregiver upload remains a read-only extraction without a parent draft.
      if (!documentId) {
        response.json(extracted);
        return;
      }

      response.json({
        documentId,
        status: "needs_confirmation",
        review: buildReviewPayload(extracted),
      });
    } catch (error: unknown) {
      console.error("Document extraction failed");
      response.status(400).json({ error: "We couldn't process this document. Try another PDF or image." });
    }
  });

  app.post("/api/documents/:id/confirm", async (request, response) => {
    const documentId = request.params.id;
    const body = request.body as Record<string, unknown> | undefined;
    const userId = parseUserId(body?.userId);

    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const result = await confirmDocument({ documentId, userId, editedData: body?.editedData });
      response.json(result);
    } catch (error: unknown) {
      if (error instanceof DocumentAccessError) {
        response.status(404).json({ error: "Document not found" });
        return;
      }
      if (error instanceof DocumentValidationError) {
        response.status(400).json({ error: "We couldn't save your corrections. Please check the fields and try again." });
        return;
      }
      if (error instanceof DocumentNotConfirmableError) {
        response.status(409).json({ error: error.message });
        return;
      }
      console.error("Failed to confirm document");
      response.status(500).json({ error: "We couldn't save this information. Please try again." });
    }
  });

  app.get("/api/parent/latest-changes", async (request, response) => {
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

      const result = await getLatestChanges(parentId);
      response.json(result);
    } catch (error: unknown) {
      console.error("Failed to load latest changes", error);
      response.status(500).json({ error: "Unable to load recent changes" });
    }
  });

  app.get("/api/parent/background", async (request, response) => {
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

      const background = await getParentBackground(parentId);
      if (!background) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      response.json(background);
    } catch (error: unknown) {
      console.error("Failed to load parent background", error);
      response.status(500).json({ error: "Unable to load background information" });
    }
  });

  app.get("/api/parent/schedule", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    if (!isValidScheduleRange(request.query.range)) {
      response.status(400).json({ error: "range must be one of: today, tomorrow, week, upcoming" });
      return;
    }
    const range = request.query.range;
    const timezone = resolveTimezone(request.query.timezone);

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      const events = await getParentSchedule(parentId, range, timezone);
      response.json({ range, timezone, events });
    } catch (error: unknown) {
      console.error("Failed to load parent schedule", error);
      response.status(500).json({ error: "Unable to load schedule information" });
    }
  });

  app.post("/api/parent/caregiver-actions", async (request, response) => {
    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    const text = parseActionText((request.body as Record<string, unknown> | undefined)?.text);
    const conversationId = parseOptionalConversationId(
      (request.body as Record<string, unknown> | undefined)?.conversationId
    );

    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    if (!text) {
      response.status(400).json({ error: "text is required and must be 500 characters or fewer" });
      return;
    }

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      const action = await createCaregiverAction({
        parentId,
        createdByUserId: userId,
        text,
        conversationId,
      });

      response.status(201).json({ status: "created", action });
    } catch (error: unknown) {
      console.error("Failed to create caregiver action", error);
      response.status(500).json({ error: "Unable to create caregiver action" });
    }
  });

  app.post("/api/parent/voice-conversations/register", async (request, response) => {
    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    const conversationId = parseOptionalConversationId(
      (request.body as Record<string, unknown> | undefined)?.conversationId
    );

    if (!userId || !conversationId) {
      response.status(400).json({ error: "userId and conversationId are required" });
      return;
    }

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      await registerVoiceConversation(parentId, conversationId);
      response.status(201).json({ status: "registered" });
    } catch (error: unknown) {
      console.error("Failed to register voice conversation", error);
      response.status(500).json({ error: "Unable to register conversation" });
    }
  });

  app.post("/api/parent/voice-conversations/sync", async (request, response) => {
    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    const conversationId = parseOptionalConversationId(
      (request.body as Record<string, unknown> | undefined)?.conversationId
    );

    if (!userId || !conversationId) {
      response.status(400).json({ error: "userId and conversationId are required" });
      return;
    }

    try {
      const parentId = await getParentIdForUser(userId);
      if (!parentId) {
        response.status(404).json({ error: "No parent profile found for this user" });
        return;
      }

      const syncStatus = await syncVoiceConversation(parentId, conversationId);
      if (syncStatus === "not_owned") {
        response.status(404).json({ error: "Conversation is not registered to this user" });
        return;
      }
      if (syncStatus === "unavailable") {
        response.status(502).json({ status: "unavailable", error: "ElevenLabs did not return conversation details" });
        return;
      }

      response.json({ status: syncStatus });
    } catch (error: unknown) {
      console.error("Failed to sync voice conversation", error);
      response.status(500).json({ error: "Unable to sync conversation" });
    }
  });

  app.get("/api/caregiver/actions", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const parentIds = await getApprovedParentIdsForCaregiver(userId);
      const actions = await listCaregiverActions(parentIds);
      response.json({ actions });
    } catch (error: unknown) {
      console.error("Failed to load caregiver actions", error);
      response.status(500).json({ error: "Unable to load caregiver actions" });
    }
  });

  app.patch("/api/caregiver/actions/:id", async (request, response) => {
    const userId = parseUserId((request.body as Record<string, unknown> | undefined)?.userId);
    const statusValue = (request.body as Record<string, unknown> | undefined)?.status;
    const status = statusValue === "open" || statusValue === "done" ? statusValue : null;

    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    if (!status) {
      response.status(400).json({ error: "status must be 'open' or 'done'" });
      return;
    }

    try {
      const updated = await updateActionStatus({ actionId: request.params.id, userId, status });
      if (!updated) {
        response.status(404).json({ error: "Action not found" });
        return;
      }

      response.json({ status: "updated", action: updated });
    } catch (error: unknown) {
      console.error("Failed to update caregiver action", error);
      response.status(500).json({ error: "Unable to update caregiver action" });
    }
  });

  app.get("/api/caregiver/actions/:id/conversation", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const result = await getActionConversation(request.params.id, userId);
      if (!result) {
        response.status(404).json({ error: "Action not found" });
        return;
      }

      response.json(result);
    } catch (error: unknown) {
      console.error("Failed to load action conversation", error);
      response.status(500).json({ error: "Unable to load conversation" });
    }
  });

  app.get("/api/caregiver/documents", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const parentIds = await getApprovedParentIdsForCaregiver(userId);
      const documents = await listSharedDocuments(parentIds);
      response.json({ documents });
    } catch (error: unknown) {
      console.error("Failed to load shared documents", error);
      response.status(500).json({ error: "Unable to load shared documents" });
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

  app.get("/api/parent/streak", async (request, response) => {
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

    const result = await getPool().query(
      `SELECT streak, last_checkin_date, last_active_week FROM parent_streak WHERE parent_id = $1`,
      [parentId]
    );

    if (result.rows.length === 0) {
      response.json({ streak: 0 });
      return;
    }

    response.json({
      streak: result.rows[0].streak,
      lastCheckinDate: result.rows[0].last_checkin_date,
      lastActiveWeek: result.rows[0].last_active_week,
    });
  } catch (error: unknown) {
    console.error("Failed to load streak", error);
    response.status(500).json({ error: "Unable to load streak" });
  }
});

  app.get("/api/users/:id/parent", async (request, response, next) => {
    try {
      const pool = getPool();
      const relResult = await pool.query<{ parent_id: string; status: string }>(
        `SELECT parent_id, status FROM parent_relationships WHERE user_id = $1 LIMIT 1`,
        [request.params.id]
      );
      if (relResult.rows.length > 0) {
        const { parent_id: parentId, status } = relResult.rows[0];
        if (status === "pending") {
          await pool.query(
            `UPDATE parent_relationships
             SET status = 'approved',
                 approved_by = (SELECT user_id FROM parents WHERE id = $2),
                 approved_at = NOW()
             WHERE user_id = $1 AND parent_id = $2`,
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

      const parentSelf = await pool.query(
        `SELECT id, full_name AS name, background_notes FROM parents WHERE user_id = $1 LIMIT 1`,
        [request.params.id]
      );
      if (parentSelf.rows.length > 0) {
        response.json({ parentId: parentSelf.rows[0].id, parent: parentSelf.rows[0] });
        return;
      }

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

  app.get("/api/parents/:id/schedule", async (request, response, next) => {
    try {
      const result = await getPool().query(
        `SELECT id, title, description, category, start_time, end_time,
                location, address, with_whom, status, attendance_status, point_value, points_earned, points_review
         FROM schedule
         WHERE parent_id = $1
           AND start_time >= NOW()
         ORDER BY start_time ASC
         LIMIT 50`,
        [request.params.id]
      );
      response.json(result.rows);
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/parents/:id/schedule/past", async (request, response, next) => {
    try {
      const result = await getPool().query(
        `SELECT id, title, description, category, start_time, end_time,
                location, address, with_whom, status, attendance_status, point_value, points_earned, points_review
         FROM schedule
         WHERE parent_id = $1
           AND start_time < NOW()
         ORDER BY start_time DESC
         LIMIT 20`,
        [request.params.id]
      );
      response.json(result.rows);
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/parents/:id/schedule/score", async (request, response, next) => {
    try {
      const scoredEvents = await scoreUnreviewedSchedule(request.params.id);
      response.json({ scoredEvents });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.use(gameRoutes);
  app.use(streakRoutes);
  app.use(errorHandler);
  return app;
}