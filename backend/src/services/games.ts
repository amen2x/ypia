import { getPool } from "../db.js";
import type { TriviaParent } from "./trivia.js";

// ---------------------------------------------------------------------
// Who can do what, saving game results and surveys, and the weekly trend.
// ---------------------------------------------------------------------

export class GameError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A pause longer than this before a move counts as a hesitation.
export const HESITATION_SECONDS = 10;

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------

// Games are played by the parent, so the logged-in user must own a parent profile.
export async function requirePlayer(userId: string): Promise<TriviaParent> {
  const { rows } = await getPool().query<TriviaParent>(
    `SELECT id, full_name, preferred_name, background_notes
     FROM parents
     WHERE user_id = $1`,
    [userId],
  );
  if (rows.length === 0) throw new GameError(403, "Only a parent account can play the games");
  return rows[0];
}

// The trend can be seen by the parent herself or an approved family member.
// With no parentId, a parent sees her own trend.
export async function requireViewer(userId: string, parentId: string | undefined): Promise<string> {
  if (!parentId) {
    const own = await getPool().query<{ id: string }>("SELECT id FROM parents WHERE user_id = $1", [userId]);
    if (own.rows.length === 0) throw new GameError(400, "parentId is required for a family account");
    return own.rows[0].id;
  }

  const { rows } = await getPool().query<{ allowed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM parents WHERE id = $2 AND user_id = $1)
         OR EXISTS (SELECT 1 FROM parent_relationships
                    WHERE parent_id = $2 AND user_id = $1 AND status = 'approved') AS allowed`,
    [userId, parentId],
  );
  if (!rows[0]?.allowed) throw new GameError(403, "You don't have access to this parent");
  return parentId;
}

// ---------------------------------------------------------------------
// Saving a game
// ---------------------------------------------------------------------

export interface TriviaAnswer {
  n: number;
  kind: "memory" | "recall" | "interest";
  topic?: string;
  question: string;
  choices: string[];
  answerIndex: number;
  chosenIndex: number;
  seconds: number; // time she took to answer
}

export interface PuzzleMove {
  seconds: number; // time since her previous move (or since the start)
  ok: boolean;     // false = wrong number (Sudoku) or a move that isn't allowed (Solitaire)
}

interface GameBase {
  playDate: string;   // her local date, YYYY-MM-DD
  startedAt: string;  // ISO time
  finishedAt: string; // ISO time
  completed: boolean; // false = she stopped early
}

export type GameResultInput =
  | (GameBase & { game: "trivia"; answers: TriviaAnswer[] })
  | (GameBase & { game: "sudoku" | "solitaire"; moves: PuzzleMove[]; info?: Record<string, string | number | boolean> });

export interface GameSummary {
  avgSeconds: number | null;
  questionsAnswered: number | null;
  correctAnswers: number | null;
  memoryAnswered: number | null;
  memoryCorrect: number | null;
  moves: number | null;
  mistakes: number | null;
  hesitations: number | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

// The numbers are worked out here from the raw answers or moves,
// so every game is counted the same way.
export function summarize(input: GameResultInput): GameSummary {
  if (input.game === "trivia") {
    const isRight = (answer: TriviaAnswer) => answer.chosenIndex === answer.answerIndex;
    const memory = input.answers.filter((answer) => answer.kind !== "interest");
    return {
      avgSeconds: average(input.answers.map((answer) => answer.seconds)),
      questionsAnswered: input.answers.length,
      correctAnswers: input.answers.filter(isRight).length,
      memoryAnswered: memory.length,
      memoryCorrect: memory.filter(isRight).length,
      moves: null,
      mistakes: null,
      hesitations: null,
    };
  }

  return {
    avgSeconds: average(input.moves.map((move) => move.seconds)),
    questionsAnswered: null,
    correctAnswers: null,
    memoryAnswered: null,
    memoryCorrect: null,
    moves: input.moves.length,
    mistakes: input.moves.filter((move) => !move.ok).length,
    hesitations: input.moves.filter((move) => move.seconds > HESITATION_SECONDS).length,
  };
}

export async function saveGameResult(
  parentId: string,
  userId: string,
  input: GameResultInput,
): Promise<{ id: string; summary: GameSummary }> {
  const summary = summarize(input);
  const details = input.game === "trivia"
    ? { answers: input.answers }
    : { moves: input.moves, info: input.info ?? {} };

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO game_results
       (parent_id, played_by, game, play_date, started_at, finished_at, completed,
        avg_seconds, questions_answered, correct_answers, memory_answered, memory_correct,
        moves, mistakes, hesitations, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      parentId, userId, input.game, input.playDate, input.startedAt, input.finishedAt, input.completed,
      summary.avgSeconds, summary.questionsAnswered, summary.correctAnswers,
      summary.memoryAnswered, summary.memoryCorrect,
      summary.moves, summary.mistakes, summary.hesitations,
      JSON.stringify(details),
    ],
  );
  return { id: rows[0].id, summary };
}

// ---------------------------------------------------------------------
// Survey (end of trivia)
// ---------------------------------------------------------------------

export async function saveSurvey(
  parentId: string,
  input: { gameResultId: string; enjoyed: boolean; moreAbout: string | null },
): Promise<{ id: string }> {
  const game = await getPool().query<{ game: string }>(
    "SELECT game FROM game_results WHERE id = $1 AND parent_id = $2",
    [input.gameResultId, parentId],
  );
  if (game.rows.length === 0) throw new GameError(404, "That game was not found");
  if (game.rows[0].game !== "trivia") throw new GameError(400, "Surveys are only for trivia");

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO game_surveys (game_result_id, enjoyed, more_about)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.gameResultId, input.enjoyed, input.moreAbout],
    );
    return { id: rows[0].id };
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "23505") {
      throw new GameError(409, "The survey for this game was already saved");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// Weekly trend (weeks run Sunday to Saturday)
// Compares her only with her own past weeks. Not a diagnosis.
// ---------------------------------------------------------------------

interface TrendRow {
  week_start: string;
  game: "trivia" | "sudoku" | "solitaire" | null;
  games: number | null;
  questions_answered: number | null;
  correct_answers: number | null;
  memory_answered: number | null;
  memory_correct: number | null;
  moves: number | null;
  mistakes: number | null;
  hesitations: number | null;
  avg_seconds: number | null;
}

export interface TriviaWeek {
  games: number;
  correctPct: number | null;
  memoryPct: number | null;
  avgSecondsPerAnswer: number | null;
}

export interface PuzzleWeek {
  games: number;
  avgSecondsPerMove: number | null;
  mistakesPerGame: number | null;
  hesitationsPerGame: number | null;
}

export interface TrendWeek {
  weekStart: string; // the Sunday, YYYY-MM-DD
  trivia: TriviaWeek | null;
  sudoku: PuzzleWeek | null;
  solitaire: PuzzleWeek | null;
}

function percent(part: number | null, whole: number | null): number | null {
  if (part === null || !whole) return null;
  return Math.round((part / whole) * 100);
}

function oneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export async function getTrend(parentId: string, today: string | undefined, weekCount: number): Promise<TrendWeek[]> {
  const { rows } = await getPool().query<TrendRow>(
    `WITH params AS (
       SELECT coalesce($2::date, current_date) AS today
     ),
     weeks AS (
       SELECT (p.today - EXTRACT(DOW FROM p.today)::int - 7 * k) AS week_start
       FROM params p, generate_series(0, $3::int - 1) AS k
     ),
     totals AS (
       SELECT (play_date - EXTRACT(DOW FROM play_date)::int) AS week_start,
              game,
              count(*)::int                AS games,
              sum(questions_answered)::int AS questions_answered,
              sum(correct_answers)::int    AS correct_answers,
              sum(memory_answered)::int    AS memory_answered,
              sum(memory_correct)::int     AS memory_correct,
              sum(moves)::int              AS moves,
              sum(mistakes)::int           AS mistakes,
              sum(hesitations)::int        AS hesitations,
              (sum(avg_seconds * coalesce(questions_answered, moves))
                 / nullif(sum(coalesce(questions_answered, moves)) FILTER (WHERE avg_seconds IS NOT NULL), 0)
              )::float8                    AS avg_seconds
       FROM game_results
       WHERE parent_id = $1
         AND play_date >= (SELECT min(week_start) FROM weeks)
         AND play_date <= (SELECT today FROM params)
       GROUP BY 1, 2
     )
     SELECT to_char(w.week_start, 'YYYY-MM-DD') AS week_start,
            t.game, t.games, t.questions_answered, t.correct_answers,
            t.memory_answered, t.memory_correct, t.moves, t.mistakes, t.hesitations, t.avg_seconds
     FROM weeks w
     LEFT JOIN totals t ON t.week_start = w.week_start
     ORDER BY w.week_start, t.game`,
    [parentId, today ?? null, weekCount],
  );

  const weeks = new Map<string, TrendWeek>();
  for (const row of rows) {
    const week = weeks.get(row.week_start) ?? { weekStart: row.week_start, trivia: null, sudoku: null, solitaire: null };
    weeks.set(row.week_start, week);
    if (!row.game || !row.games) continue;

    if (row.game === "trivia") {
      week.trivia = {
        games: row.games,
        correctPct: percent(row.correct_answers, row.questions_answered),
        memoryPct: percent(row.memory_correct, row.memory_answered),
        avgSecondsPerAnswer: oneDecimal(row.avg_seconds),
      };
    } else {
      week[row.game] = {
        games: row.games,
        avgSecondsPerMove: oneDecimal(row.avg_seconds),
        mistakesPerGame: oneDecimal(row.mistakes === null ? null : row.mistakes / row.games),
        hesitationsPerGame: oneDecimal(row.hesitations === null ? null : row.hesitations / row.games),
      };
    }
  }
  return [...weeks.values()];
}
