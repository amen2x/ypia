import { createHash } from "node:crypto";
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
import {
  saveDocumentExtraction,
  getLatestChanges,
  findDocumentByContent,
  listParentDocuments,
  getParentDocumentDraft,
} from "./services/documentHistory.js";
import { GeminiExtractionError } from "./services/gemini.js";
import { DocumentUploadError, MAX_UPLOAD_BYTES, validateUpload, type UploadErrorCode } from "./services/uploadValidation.js";
import { extractedDocumentSchema } from "./schemas.js";
import {
  buildReviewNotes,
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
  scheduleAction,
} from "./services/caregiverActions.js";
import { CALENDAR_ITEM_KINDS, loadCalendarItem, type CalendarItemKind } from "./services/calendarItems.js";
import { CalendarInputError, contentDisposition, googleCalendarUrl, icsCalendar } from "./calendarExport.js";
import { registerVoiceConversation, syncVoiceConversation } from "./services/voiceConversations.js";
import { listSharedDocuments } from "./services/caregiverDocuments.js";
import {
  isApprovedCaregiverFor,
  listApprovedParents,
  listChangeSourceDocuments,
  listConfirmedMedications,
  listUpcomingAppointments,
} from "./services/caregiverOverview.js";
import { checkInParent } from "./services/checkIns.js";
import { DatabaseConfigurationError, getPool } from "./db.js";
import { scoreUnreviewedSchedule } from "./services/schedulePoints.js";
import { signupSchema, loginSchema, backgroundNotesSchema } from "./schemas.js";
import { gameRoutes } from "./gameRoutes.js";
import { streakRoutes } from "./streakRoutes.js";
import { calendarRoutes, isCalendarDate } from "./calendarRoutes.js";

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

const TIME_24H_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ParsedScheduledFields {
  scheduledDate: string | null;
  scheduledTime: string | null;
  scheduledEndTime: string | null;
}

// Only ElevenLabs' own structured tool-call parameters are trusted here — this
// never parses/regexes the action's free-text prose. Malformed or logically
// inconsistent input is rejected outright rather than silently dropped, since
// (unlike appointmentId) there is no independent source of truth to fall back
// on: a bad value here would otherwise become an incorrectly-unscheduled or
// incorrectly-scheduled action with no way to tell it apart from a real one.
export function parseScheduledFields(body: Record<string, unknown> | undefined): ParsedScheduledFields | string {
  const rawDate = body?.scheduledDate;
  const rawTime = body?.scheduledTime;
  const rawEndTime = body?.scheduledEndTime;

  for (const [field, value] of Object.entries({ scheduledDate: rawDate, scheduledTime: rawTime, scheduledEndTime: rawEndTime })) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      return `${field} must be a string or null`;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      return `${field} must not be empty`;
    }
  }

  const scheduledDate = typeof rawDate === "string" && rawDate.trim().length > 0 ? rawDate.trim() : null;
  const scheduledTime = typeof rawTime === "string" && rawTime.trim().length > 0 ? rawTime.trim() : null;
  const scheduledEndTime = typeof rawEndTime === "string" && rawEndTime.trim().length > 0 ? rawEndTime.trim() : null;

  if (scheduledDate && !isCalendarDate(scheduledDate)) {
    return "scheduledDate must be a valid YYYY-MM-DD date";
  }
  if (scheduledTime && !TIME_24H_PATTERN.test(scheduledTime)) {
    return "scheduledTime must be a valid 24-hour HH:mm time";
  }
  if (scheduledEndTime && !TIME_24H_PATTERN.test(scheduledEndTime)) {
    return "scheduledEndTime must be a valid 24-hour HH:mm time";
  }
  if (scheduledTime && !scheduledDate) {
    return "scheduledTime requires scheduledDate";
  }
  if (scheduledEndTime && !scheduledTime) {
    return "scheduledEndTime requires scheduledTime";
  }
  if (scheduledEndTime && scheduledTime && scheduledEndTime < scheduledTime) {
    return "scheduledEndTime cannot be earlier than scheduledTime";
  }

  return { scheduledDate, scheduledTime, scheduledEndTime };
}

const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// Runs multer for the single "document" field and turns its failures into the same typed,
// parent-safe errors the rest of the upload path uses.
function acceptDocument(request: Request, response: Response, next: NextFunction): void {
  documentUpload.single("document")(request, response, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    sendUploadError(response, new DocumentUploadError(tooLarge ? "file_too_large" : "unreadable_file"));
  });
}

function sendUploadError(response: Response, error: DocumentUploadError): void {
  response.status(error.httpStatus).json({ error: error.message, code: error.code });
}

function toUploadError(error: unknown): DocumentUploadError {
  if (error instanceof DocumentUploadError) return error;
  if (error instanceof GeminiExtractionError) {
    const codes: Record<GeminiExtractionError["kind"], UploadErrorCode> = {
      not_configured: "ai_not_configured",
      unavailable: "ai_unavailable",
      bad_output: "ai_bad_output",
      unreadable_input: "unreadable_file",
    };
    return new DocumentUploadError(codes[error.kind]);
  }
  return new DocumentUploadError("ai_unavailable");
}
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

async function processUpload(file: Express.Multer.File, extension: string) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "tigerhacks-document-"));
  const temporaryFile = path.join(temporaryDirectory, `upload${extension}`);

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

  // Returns a short-lived signed URL for the browser's ElevenLabs session. Failures carry a stable
  // `code` so the app can tell the parent (and a developer) what is wrong. Neither the responses nor
  // the logs ever contain the API key, the agent id or the signed URL: only variable NAMES, status
  // codes and error codes.
  app.get("/api/elevenlabs/signed-url", async (_request, response) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    function fail(status: number, code: string, error: string, detail?: string): void {
      console.warn(`[voice] signed-url failed: ${code}${detail ? ` (${detail})` : ""}`);
      response.status(status).json({ error, code });
    }

    const missing = [!apiKey && "ELEVENLABS_API_KEY", !agentId && "ELEVENLABS_AGENT_ID"].filter(Boolean);
    if (!apiKey || !agentId) {
      fail(500, "not_configured", "ElevenLabs is not configured", `missing: ${missing.join(", ")}`);
      return;
    }

    try {
      const elevenLabsResponse = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey } }
      );

      if (!elevenLabsResponse.ok) {
        const upstream = elevenLabsResponse.status;
        if (upstream === 401 || upstream === 403) {
          fail(502, "elevenlabs_auth", "The voice service rejected this server's credentials or agent settings", `upstream ${upstream}`);
        } else if (upstream === 400 || upstream === 404 || upstream === 422) {
          fail(502, "elevenlabs_agent", "The voice service could not find or accept the configured agent", `upstream ${upstream}`);
        } else if (upstream === 429) {
          fail(502, "elevenlabs_rate_limited", "The voice service is busy right now", `upstream ${upstream}`);
        } else {
          fail(502, "elevenlabs_unavailable", "The voice service had a problem", `upstream ${upstream}`);
        }
        return;
      }

      const body = (await elevenLabsResponse.json()) as { signed_url?: string };
      if (!body.signed_url) {
        fail(502, "no_signed_url", "The voice service did not return a session link");
        return;
      }

      // A voice session is starting: open a database connection now so the first tool call is fast.
      void getPool().query("SELECT 1").catch(() => undefined);
      response.json({ signedUrl: body.signed_url });
    } catch {
      fail(502, "elevenlabs_unreachable", "Could not reach the voice service");
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

  app.post("/api/documents", acceptDocument, async (request, response, next) => {
    if (!request.file) {
      sendUploadError(response, new DocumentUploadError("no_file"));
      return;
    }

    let validated: { mediaType: string; extension: string };
    try {
      validated = validateUpload(request.file.originalname, request.file.buffer);
    } catch (error: unknown) {
      sendUploadError(response, toUploadError(error));
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

    const contentHash = createHash("sha256").update(request.file.buffer).digest("hex");

    try {
      // The same file from the same parent is the same document: hand back the existing one
      // instead of reading it again or creating a second record.
      if (userId && parentId) {
        const existing = await findDocumentByContent(parentId, contentHash);
        if (existing) {
          response.json(await duplicateResponse(parentId, existing));
          return;
        }
      }

      const extracted = await processUpload(request.file, validated.extension);
      let saved: { id: string; duplicate: boolean } | null = null;

      if (userId && parentId) {
        try {
          saved = await saveDocumentExtraction({
            parentId,
            uploadedBy: userId,
            documentName: request.file.originalname,
            mimeType: validated.mediaType,
            fileSizeBytes: request.file.size,
            contentHash,
            extractedData: extracted,
          });
        } catch (persistError: unknown) {
          console.error("Failed to persist document extraction", persistError);
          sendUploadError(response, new DocumentUploadError("save_failed"));
          return;
        }
      }

      // The caregiver upload remains a read-only extraction without a parent draft.
      if (!saved || !parentId) {
        response.json(extracted);
        return;
      }

      if (saved.duplicate) {
        // Another request saved the same file while this one was being read.
        const existing = await findDocumentByContent(parentId, contentHash);
        if (existing) {
          response.json(await duplicateResponse(parentId, existing));
          return;
        }
      }

      response.json({
        documentId: saved.id,
        status: "needs_confirmation",
        duplicate: false,
        review: buildReviewPayload(extracted),
        notes: await safeReviewNotes(parentId, extracted),
      });
    } catch (error: unknown) {
      const uploadError = toUploadError(error);
      // Codes and sanitized provider messages only; never the file, its contents, or a key.
      console.error(`Document extraction failed (${uploadError.code})`, error instanceof GeminiExtractionError ? error.message : "");
      sendUploadError(response, uploadError);
    }
  });

  async function safeReviewNotes(parentId: string, document: Parameters<typeof buildReviewNotes>[1]) {
    try {
      return await buildReviewNotes(parentId, document);
    } catch (error: unknown) {
      // Notes are a convenience; the review itself must still open.
      console.error("Failed to build review notes", error);
      return [];
    }
  }

  async function duplicateResponse(parentId: string, existing: { id: string; status: string; extractedData: unknown }) {
    const parsedDraft = extractedDocumentSchema.safeParse(existing.extractedData);
    if (existing.status === "confirmed" || !parsedDraft.success) {
      return { documentId: existing.id, status: existing.status, duplicate: true };
    }
    const draft = await normalizeMedications(parsedDraft.data);
    return {
      documentId: existing.id,
      status: "needs_confirmation",
      duplicate: true,
      review: buildReviewPayload(draft),
      notes: await safeReviewNotes(parentId, draft),
    };
  }

  // The signed-in parent's own documents: safe metadata only, never extracted or reviewed content.
  app.get("/api/parent/documents", async (request, response) => {
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
      response.json({ documents: await listParentDocuments(parentId) });
    } catch (error: unknown) {
      console.error("Failed to list parent documents", error);
      response.status(500).json({ error: "Unable to load your documents" });
    }
  });

  // Reopen a draft the parent left unconfirmed. Only their own document, and the extraction
  // is returned only while it is still an unconfirmed draft.
  app.get("/api/parent/documents/:id/review", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    try {
      const parentId = await getParentIdForUser(userId);
      const draft = parentId ? await getParentDocumentDraft(parentId, request.params.id) : null;
      if (!parentId || !draft) {
        response.status(404).json({ error: "Document not found" });
        return;
      }
      const parsedDraft = extractedDocumentSchema.safeParse(draft.extractedData);
      if (draft.status === "confirmed" || !parsedDraft.success) {
        response.json({ documentId: draft.id, status: draft.status });
        return;
      }
      const normalized = await normalizeMedications(parsedDraft.data);
      response.json({
        documentId: draft.id,
        status: "needs_confirmation",
        review: buildReviewPayload(normalized),
        notes: await safeReviewNotes(parentId, normalized),
      });
    } catch (error: unknown) {
      console.error("Failed to load document review", error);
      response.status(500).json({ error: "Unable to load this document" });
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
    const appointmentId = parseOptionalConversationId(
      (request.body as Record<string, unknown> | undefined)?.appointmentId
    );
    const scheduledFields = parseScheduledFields(request.body as Record<string, unknown> | undefined);

    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    if (!text) {
      response.status(400).json({ error: "text is required and must be 500 characters or fewer" });
      return;
    }
    if (typeof scheduledFields === "string") {
      response.status(400).json({ error: scheduledFields });
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
        appointmentId,
        ...scheduledFields,
      });

      // Safe, value-free trace for local debugging: which parent-side request reached the database.
      console.log(`[voice] caregiver action ${action.duplicate ? "repeat ignored" : "created"}: id=${action.id.slice(0, 8)} linked=${action.appointmentLinked} scheduled=${action.scheduled}`);
      response.status(action.duplicate ? 200 : 201).json({ status: action.duplicate ? "duplicate" : "created", action });
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

  // ---- Caregiver workspace: read-only views of confirmed care information ----
  // Every route requires userId + parentId and an *approved* caregiver relationship.
  async function resolveApprovedParent(request: Request, response: Response): Promise<string | null> {
    const userId = parseUserId(request.query.userId);
    const parentId = parseUserId(request.query.parentId);
    if (!userId || !parentId) {
      response.status(400).json({ error: "userId and parentId are required" });
      return null;
    }
    if (!(await isApprovedCaregiverFor(userId, parentId))) {
      response.status(403).json({ error: "You are not linked to this parent" });
      return null;
    }
    return parentId;
  }

  app.get("/api/caregiver/parents", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      response.json({ parents: await listApprovedParents(userId) });
    } catch (error: unknown) {
      console.error("Failed to load linked parents", error);
      response.status(500).json({ error: "Unable to load linked parents" });
    }
  });

  app.get("/api/caregiver/medications", async (request, response) => {
    try {
      const parentId = await resolveApprovedParent(request, response);
      if (!parentId) return;
      response.json({ medications: await listConfirmedMedications(parentId) });
    } catch (error: unknown) {
      console.error("Failed to load caregiver medications", error);
      response.status(500).json({ error: "Unable to load medications" });
    }
  });

  app.get("/api/caregiver/appointments", async (request, response) => {
    try {
      const parentId = await resolveApprovedParent(request, response);
      if (!parentId) return;
      response.json({ appointments: await listUpcomingAppointments(parentId) });
    } catch (error: unknown) {
      console.error("Failed to load caregiver appointments", error);
      response.status(500).json({ error: "Unable to load appointments" });
    }
  });

  app.get("/api/caregiver/changes", async (request, response) => {
    try {
      const parentId = await resolveApprovedParent(request, response);
      if (!parentId) return;
      const [latest, sources] = await Promise.all([getLatestChanges(parentId), listChangeSourceDocuments(parentId)]);
      response.json({ ...latest, sources });
    } catch (error: unknown) {
      console.error("Failed to load caregiver changes", error);
      response.status(500).json({ error: "Unable to load care changes" });
    }
  });

  // A caregiver's own task. Only explicit scheduled* fields are stored; dates are
  // never inferred from the text (same rule as parent-created requests).
  app.post("/api/caregiver/actions", async (request, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    const userId = parseUserId(body?.userId);
    const parentId = parseUserId(body?.parentId);
    const text = parseActionText(body?.text);
    const scheduledFields = parseScheduledFields(body);

    if (!userId || !parentId) {
      response.status(400).json({ error: "userId and parentId are required" });
      return;
    }
    if (!text) {
      response.status(400).json({ error: "text is required and must be 500 characters or fewer" });
      return;
    }
    if (typeof scheduledFields === "string") {
      response.status(400).json({ error: scheduledFields });
      return;
    }

    try {
      if (!(await isApprovedCaregiverFor(userId, parentId))) {
        response.status(403).json({ error: "You are not linked to this parent" });
        return;
      }

      const created = await createCaregiverAction({
        parentId,
        createdByUserId: userId,
        text,
        conversationId: null,
        appointmentId: null,
        scheduledDate: scheduledFields.scheduledDate,
        scheduledTime: scheduledFields.scheduledTime,
        scheduledEndTime: scheduledFields.scheduledEndTime,
        source: "caregiver",
      });
      response.status(201).json({ status: "created", action: created });
    } catch (error: unknown) {
      console.error("Failed to create caregiver task", error);
      response.status(500).json({ error: "Unable to create task" });
    }
  });

  // ---- Caregiver calendar export: ONE stored record -> Google Calendar link or .ics file ----
  // The record's structured columns are the only source (never free text), and exporting is a
  // pure read: it creates and changes nothing in Y.P.I.A., so repeating it cannot duplicate records.
  app.get("/api/caregiver/calendar/:kind/:id", async (request, response) => {
    const userId = parseUserId(request.query.userId);
    const kind = request.params.kind as CalendarItemKind;
    const format = request.query.format === undefined || request.query.format === "google" ? "google" : request.query.format === "ics" ? "ics" : null;
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    if (!CALENDAR_ITEM_KINDS.includes(kind) || !format) {
      response.status(400).json({ error: "kind must be appointment, action or schedule, and format google or ics" });
      return;
    }

    try {
      const item = await loadCalendarItem(kind, request.params.id);
      if (item.status === "not_found") {
        response.status(404).json({ error: "Item not found" });
        return;
      }
      const approved = await getApprovedParentIdsForCaregiver(userId);
      if (!approved.includes(item.parentId)) {
        response.status(403).json({ error: "You are not linked to this parent" });
        return;
      }
      if (item.status === "not_scheduled") {
        response.status(422).json({ error: "This item has no date yet. Schedule it first.", code: "not_scheduled" });
        return;
      }

      if (format === "google") {
        response.redirect(googleCalendarUrl(item.event));
        return;
      }
      response.setHeader("Content-Type", "text/calendar; charset=utf-8");
      response.setHeader("Content-Disposition", contentDisposition(item.event.title));
      response.setHeader("Cache-Control", "no-store");
      response.send(icsCalendar([item.event]));
    } catch (error: unknown) {
      if (error instanceof CalendarInputError) {
        response.status(422).json({ error: error.message, code: "invalid_schedule" });
        return;
      }
      console.error("Failed to export calendar item", error);
      response.status(500).json({ error: "Unable to export this item" });
    }
  });

  // Gives an unscheduled task an explicit, persisted date (and optional start / end time).
  app.patch("/api/caregiver/actions/:id/schedule", async (request, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    const userId = parseUserId(body?.userId);
    if (!userId) {
      response.status(400).json({ error: "userId is required" });
      return;
    }
    if (!body || !("scheduledDate" in body)) {
      response.status(400).json({ error: "scheduledDate is required (send null to clear the schedule)" });
      return;
    }
    const fields = parseScheduledFields(body);
    if (typeof fields === "string") {
      response.status(400).json({ error: fields });
      return;
    }

    try {
      const result = await scheduleAction({
        actionId: request.params.id,
        userId,
        scheduledDate: fields.scheduledDate,
        scheduledTime: fields.scheduledTime,
        scheduledEndTime: fields.scheduledEndTime,
      });
      if (result.status === "not_found") {
        response.status(404).json({ error: "Action not found" });
        return;
      }
      if (result.status === "linked_to_appointment") {
        response.status(409).json({ error: "This task is linked to an appointment, so the appointment's time is used." });
        return;
      }
      response.json({ status: "scheduled", action: { id: result.id, date: result.date, time: result.time, endTime: result.endTime } });
    } catch (error: unknown) {
      console.error("Failed to schedule caregiver action", error);
      response.status(500).json({ error: "Unable to schedule this task" });
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