import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { DatabaseConfigurationError } from "./db.js";
import { buildTrivia } from "./services/trivia.js";
import {
  GameError,
  getTrend,
  requirePlayer,
  requireViewer,
  saveGameResult,
  saveSurvey,
} from "./services/games.js";

// ---------------------------------------------------------------------
// Game routes. Like login, the page sends the logged-in user's id
// (from localStorage "ypia_user") with every request.
//
//   POST /api/trivia/new     { userId }                    -> 10 questions
//   POST /api/games/result   { userId, game, ... }         -> saves a game
//   POST /api/trivia/survey  { userId, gameResultId, ... } -> saves the survey
//   GET  /api/games/trend?userId=...&parentId=...          -> weekly numbers
// ---------------------------------------------------------------------

export const gameRoutes = Router();

// ----- input checks -----

const userId = z.string().trim().min(1).max(100);
const seconds = z.number().finite().min(0).max(86400);

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must look like 2026-09-27")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "is not a real date");

const timestamp = z.string().datetime({ offset: true });

const triviaAnswer = z
  .object({
    n: z.number().int().min(1).max(10),
    kind: z.enum(["memory", "recall", "interest"]),
    topic: z.string().max(100).optional(),
    question: z.string().min(1).max(500),
    choices: z.array(z.string().min(1).max(200)).min(2).max(4),
    answerIndex: z.number().int().min(0).max(3),
    chosenIndex: z.number().int().min(0).max(3),
    seconds,
  })
  .refine(
    (answer) => answer.answerIndex < answer.choices.length && answer.chosenIndex < answer.choices.length,
    "answerIndex and chosenIndex must point to one of the choices",
  );

const puzzleMove = z.object({ seconds, ok: z.boolean() });

const gameBase = {
  userId,
  playDate: localDate,
  startedAt: timestamp,
  finishedAt: timestamp,
  completed: z.boolean(),
};

const gameResultSchema = z
  .discriminatedUnion("game", [
    z.object({ ...gameBase, game: z.literal("trivia"), answers: z.array(triviaAnswer).max(10) }),
    z.object({
      ...gameBase,
      game: z.enum(["sudoku", "solitaire"]),
      moves: z.array(puzzleMove).max(5000),
      info: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
    }),
  ])
  .refine((input) => Date.parse(input.startedAt) <= Date.parse(input.finishedAt), {
    message: "finishedAt must be after startedAt",
    path: ["finishedAt"],
  });

const newTriviaSchema = z.object({ userId });

const surveySchema = z.object({
  userId,
  gameResultId: z.string().trim().min(1).max(100),
  enjoyed: z.boolean(),
  moreAbout: z.string().trim().max(60).nullish().transform((value) => value || null),
});

const trendSchema = z.object({
  userId,
  parentId: z.string().trim().min(1).max(100).optional(),
  today: localDate.optional(),
  weeks: z.coerce.number().int().min(1).max(12).default(5),
});

// ----- helpers -----

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new GameError(400, `${where}${issue?.message ?? "Invalid input"}`);
  }
  return result.data;
}

// Each route handles its own errors, so the team's error handler is never affected.
function handle(route: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response) => {
    try {
      await route(request, response);
    } catch (error: unknown) {
      if (error instanceof GameError) {
        response.status(error.status).json({ error: error.message });
      } else if (error instanceof DatabaseConfigurationError) {
        response.status(500).json({ error: "The database is not configured" });
      } else {
        console.error("Game route failed:", error);
        response.status(500).json({ error: "Something went wrong. Please try again." });
      }
    }
  };
}

// ----- routes -----

gameRoutes.post("/api/trivia/new", handle(async (request, response) => {
  const input = parse(newTriviaSchema, request.body);
  const parent = await requirePlayer(input.userId);
  response.json(await buildTrivia(parent));
}));

gameRoutes.post("/api/games/result", handle(async (request, response) => {
  const input = parse(gameResultSchema, request.body);
  const parent = await requirePlayer(input.userId);
  response.status(201).json(await saveGameResult(parent.id, input.userId, input));
}));

gameRoutes.post("/api/trivia/survey", handle(async (request, response) => {
  const input = parse(surveySchema, request.body);
  const parent = await requirePlayer(input.userId);
  response.status(201).json(await saveSurvey(parent.id, input));
}));

gameRoutes.get("/api/games/trend", handle(async (request, response) => {
  const input = parse(trendSchema, request.query);
  const parentId = await requireViewer(input.userId, input.parentId);
  response.json({ parentId, weeks: await getTrend(parentId, input.today, input.weeks) });
}));
