import { GoogleGenAI } from "@google/genai";
import { getPool } from "../db.js";

interface ScheduleEventForScoring {
  id: string;
  title: string;
  description: string | null;
  category: string;
  start_time: Date;
  end_time: Date;
  location: string | null;
  with_whom: string | null;
}

interface PointReview {
  eventId: string;
  pointValue: number;
  rationale: string;
}

const pointReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          eventId: { type: "string" },
          pointValue: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string" }
        },
        required: ["eventId", "pointValue", "rationale"]
      }
    }
  },
  required: ["reviews"]
};

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  return apiKey;
}

async function reviewScheduleWithGemini(events: ScheduleEventForScoring[]): Promise<PointReview[]> {
  const apiKey = getGeminiApiKey();
  const client = new GoogleGenAI({ apiKey });
  const eventList = events.map((event) => ({
    eventId: event.id,
    title: event.title,
    description: event.description,
    category: event.category,
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(event.start_time)),
    time: event.start_time,
    location: event.location,
    withWhom: event.with_whom
  }));

  const response = await client.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: [{
      role: "user",
      parts: [{
        text: `Review these planned calendar events and distribute exactly 100 engagement points across the events on each calendar day.

These are motivational planning points only. They do not measure health, medical need, personal worth, or the value of a relationship. Use the event details only to estimate planning effort, social connection, and importance to the person's stated routine. Do not make medical claims or diagnoses. Every listed event must receive one integer score from 0 to 100; the total must equal exactly 100. Include a concise, supportive rationale for each score.

Events: ${JSON.stringify(eventList)}`
      }]
    }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: pointReviewSchema
    }
  });

  if (!response.text) throw new Error("Gemini returned no point review");
  const parsed = JSON.parse(response.text) as { reviews?: PointReview[] };
  if (!Array.isArray(parsed.reviews)) throw new Error("Gemini returned an invalid point review");

  const reviewsById = new Map(parsed.reviews.map((review) => [review.eventId, review]));
  const validated = events.map((event) => reviewsById.get(event.id));
  if (validated.some((review) => !review)) throw new Error("Gemini did not review every event");

  const reviews = validated as PointReview[];
  const totalsByDay = new Map<string, number>();
  events.forEach((event, index) => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(event.start_time));
    totalsByDay.set(day, (totalsByDay.get(day) ?? 0) + reviews[index].pointValue);
  });
  if (reviews.some((review) => !Number.isInteger(review.pointValue) || review.pointValue < 0 || review.pointValue > 100)
    || [...totalsByDay.values()].some((total) => total !== 100)) {
    throw new Error("Gemini returned points that do not total 100 for each day");
  }

  return reviews;
}

export async function scoreUnreviewedSchedule(parentId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query<ScheduleEventForScoring>(
    `SELECT id, title, description, category, start_time, end_time, location, with_whom
     FROM schedule
     WHERE parent_id = $1
       AND DATE(start_time AT TIME ZONE 'America/Chicago') IN (
         SELECT DISTINCT DATE(start_time AT TIME ZONE 'America/Chicago')
         FROM schedule
         WHERE parent_id = $1 AND point_value IS NULL
       )
     ORDER BY start_time ASC`,
    [parentId]
  );

  if (result.rows.length === 0) return 0;

  const reviews = await reviewScheduleWithGemini(result.rows);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const review of reviews) {
      await client.query(
        `UPDATE schedule
         SET point_value = $1,
             points_review = $2,
               points_earned = CASE WHEN attendance_status = 'attended' THEN $1 WHEN attendance_status = 'missed' THEN 0 ELSE NULL END
         WHERE id = $3 AND parent_id = $4`,
        [review.pointValue, review.rationale.slice(0, 500), review.eventId, parentId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return reviews.length;
}
