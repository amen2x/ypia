import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { getPool } from "../db.js";

// ---------------------------------------------------------------------
// Builds one 10-question trivia game for a parent.
//   Questions 1, 5 and 10: memory (facts the family entered, or her
//                           recent calendar events)
//   The other 7:           her interests (Gemini, or the backup list)
// If a memory question can't be made, question 5 or 10 asks her to
// recall an earlier answer instead ("recall"), and question 1 becomes
// an interest question.
// ---------------------------------------------------------------------

export type QuestionKind = "memory" | "recall" | "interest";

export interface TriviaQuestion {
  n: number;           // 1 to 10
  kind: QuestionKind;
  topic: string;
  question: string;
  choices: string[];   // 2 to 4 answers, already shuffled
  answerIndex: number; // which choice is right
}

export interface Trivia {
  questions: TriviaQuestion[];
  source: "gemini" | "backup" | "mixed"; // where the interest questions came from
}

export interface TriviaParent {
  id: string;
  full_name: string;
  preferred_name: string | null;
  background_notes: string | null;
}

type Draft = Omit<TriviaQuestion, "n" | "kind">;

interface TriviaInputs {
  facts: Draft[];               // memory questions from family_facts, freshest first
  appointment: Draft | null;    // one memory question from a recent calendar event
  topics: string[];             // "more about" answers from her surveys, newest first
  recentQuestions: Set<string>; // questions she was asked in recent games
}

const TOTAL_QUESTIONS = 10;
const MEMORY_SLOTS = new Set([1, 5, 10]);

// Same models as services/gemini.ts: if one is busy, try the next.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
// The whole Gemini attempt must finish within this time, or backup questions are used.
const GEMINI_TIME_LIMIT_MS = 9000;

const GENERIC_APPOINTMENTS = ["Dentist check-up", "Eye exam", "Physical therapy", "Hearing test"];

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Wrong answers without blanks, repeats, or anything equal to the right answer.
function cleanWrongAnswers(wrong: string[], correct: string): string[] {
  const seen = new Set([normalize(correct)]);
  const result: string[] = [];
  for (const answer of wrong) {
    const key = normalize(answer);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(answer.trim());
  }
  return result;
}

// Puts the right answer among the wrong ones in a random order.
function makeDraft(topic: string, question: string, correct: string, wrong: string[]): Draft {
  const choices = shuffle([correct.trim(), ...cleanWrongAnswers(wrong, correct).slice(0, 3)]);
  return { topic, question: question.trim(), choices, answerIndex: choices.indexOf(correct.trim()) };
}

function formatDay(date: Date, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  try {
    return date.toLocaleDateString("en-US", { ...options, timeZone: timeZone ?? undefined });
  } catch {
    return date.toLocaleDateString("en-US", options); // unknown time zone name
  }
}

function withTimeLimit<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer after ${milliseconds} ms`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

// ---------------------------------------------------------------------
// 1. Read what we know about her
// ---------------------------------------------------------------------

async function loadInputs(parentId: string): Promise<TriviaInputs> {
  const pool = getPool();

  const [factRows, topicRows, recentRows] = await Promise.all([
    pool.query<{ question: string; answer: string; wrong_answers: string[] }>(
      `SELECT question, answer, wrong_answers
       FROM family_facts
       WHERE parent_id = $1`,
      [parentId],
    ),
    pool.query<{ more_about: string }>(
      `SELECT s.more_about
       FROM game_surveys s
       JOIN game_results r ON r.id = s.game_result_id
       WHERE r.parent_id = $1 AND s.more_about IS NOT NULL
       ORDER BY s.created_at DESC
       LIMIT 3`,
      [parentId],
    ),
    pool.query<{ details: unknown }>(
      `SELECT details
       FROM game_results
       WHERE parent_id = $1 AND game = 'trivia'
       ORDER BY created_at DESC
       LIMIT 5`,
      [parentId],
    ),
  ]);

  // Questions from her last 5 trivia games, so we don't repeat them.
  const recentQuestions = new Set<string>();
  for (const row of recentRows.rows) {
    const answers = (row.details as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(answers)) continue;
    for (const answer of answers) {
      if (answer && typeof answer.question === "string") recentQuestions.add(normalize(answer.question));
    }
  }

  // Facts with at least 2 wrong answers (3+ buttons). Not-asked-lately first.
  const usable = factRows.rows
    .map((fact) => makeDraft("Your life", fact.question, fact.answer, fact.wrong_answers))
    .filter((draft) => draft.choices.length >= 3);
  const fresh = shuffle(usable.filter((draft) => !recentQuestions.has(normalize(draft.question))));
  const asked = shuffle(usable.filter((draft) => recentQuestions.has(normalize(draft.question))));

  return {
    facts: [...fresh, ...asked],
    appointment: await loadRecentEventQuestion(parentId),
    topics: topicRows.rows.map((row) => row.more_about),
    recentQuestions,
  };
}

// "On Tuesday, October 6, what did you do?"
// Uses the most recent event in the last 14 days from the team's calendar
// (schedule table), or else from appointments. Her other events (on other
// days) are the wrong answers. Both tables belong to the team, so if
// anything about them fails we just skip this question.
const EVENT_SOURCES = [
  {
    name: "schedule",
    sql: `SELECT title, start_time AS starts_at
          FROM schedule
          WHERE parent_id::text = $1
            AND title IS NOT NULL AND btrim(title) <> ''
            AND lower(coalesce(status::text, '')) NOT IN ('cancelled', 'canceled', 'missed', 'no_show')
            AND start_time BETWEEN now() - interval '60 days' AND now() + interval '60 days'
          ORDER BY start_time DESC
          LIMIT 100`,
    ask: (day: string) => `On ${day}, what did you do?`,
    filler: ["Went to the grocery store", "Visited the library", "Went to the hair salon"],
  },
  {
    name: "appointments",
    sql: `SELECT title, starts_at
          FROM appointments
          WHERE parent_id = $1
            AND title IS NOT NULL AND btrim(title) <> ''
            AND lower(coalesce(status::text, '')) NOT IN ('cancelled', 'canceled', 'missed', 'no_show')
            AND starts_at BETWEEN now() - interval '60 days' AND now() + interval '60 days'
          ORDER BY starts_at DESC
          LIMIT 100`,
    ask: (day: string) => `On ${day}, what was your appointment?`,
    filler: GENERIC_APPOINTMENTS,
  },
];

async function loadRecentEventQuestion(parentId: string): Promise<Draft | null> {
  const now = Date.now();
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

  for (const source of EVENT_SOURCES) {
    try {
      const { rows } = await getPool().query<{ title: string; starts_at: Date }>(source.sql, [parentId]);
      const recent = rows.find((row) => row.starts_at.getTime() < now && row.starts_at.getTime() >= twoWeeksAgo);
      if (!recent) continue;

      const day = formatDay(recent.starts_at, null);
      const otherTitles = rows
        .filter((row) => formatDay(row.starts_at, null) !== day)
        .map((row) => row.title);
      const wrong = cleanWrongAnswers([...shuffle(otherTitles), ...shuffle(source.filler)], recent.title);
      if (wrong.length < 2) continue;

      return makeDraft("Recent schedule", source.ask(day), recent.title, wrong);
    } catch (error: unknown) {
      console.warn(`Trivia: skipped the ${source.name} question:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// 2. Interest questions from Gemini
// ---------------------------------------------------------------------

const triviaJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          answerIndex: { type: "integer" },
        },
        required: ["topic", "question", "choices", "answerIndex"],
      },
    },
  },
  required: ["questions"],
};

const geminiQuestionSchema = z.object({
  topic: z.string().trim().min(1).max(60),
  question: z.string().trim().min(8).max(300),
  choices: z.array(z.string().trim().min(1).max(120)).length(4),
  answerIndex: z.number().int().min(0).max(3),
});

function buildPrompt(parent: TriviaParent, inputs: TriviaInputs, count: number): string {
  const name = parent.preferred_name?.trim() || parent.full_name.trim().split(/\s+/)[0] || "the player";
  const interests = parent.background_notes?.trim() || "Not known yet. Use friendly general knowledge: music, gardening, history, geography, movies.";
  const requests = inputs.topics.length > 0 ? inputs.topics.join("; ") : "None yet.";
  const avoid = [...inputs.recentQuestions].slice(0, 40).map((question) => `- ${question}`).join("\n") || "- (none)";

  return `Write ${count} multiple-choice trivia questions for ${name}, an older adult, based on their background and interests.

Their background and interests: ${interests}
Topics they asked for more of (use these first): ${requests}

Rules:
- Every question is about one of their interests or requested topics. Spread them across different interests.
- Exactly 4 short answer choices and exactly one correct answer. answerIndex is the position (0 to 3) of the correct choice.
- The correct answer must be a well-known fact that is easy to check. No trick questions and no opinions.
- Easy to medium difficulty. Warm, respectful wording.
- Each question under 25 words. Each choice under 8 words.
- Do not ask about illness, dying, or memory loss.
- topic is 1 to 3 words, for example "Gardening" or "Motown".
- Do not repeat these recent questions:
${avoid}`;
}

// Keeps only well-formed, new questions. Exported for testing.
export function parseGeminiTrivia(text: string | undefined, avoid: Set<string>): Draft[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];

  const seen = new Set(avoid);
  const drafts: Draft[] = [];
  for (const item of list) {
    const parsed = geminiQuestionSchema.safeParse(item);
    if (!parsed.success) continue;
    const { topic, question, choices, answerIndex } = parsed.data;
    if (new Set(choices.map(normalize)).size !== 4) continue; // choices must all differ
    const key = normalize(question);
    if (seen.has(key)) continue;
    seen.add(key);
    const correct = choices[answerIndex];
    drafts.push(makeDraft(topic, question, correct, choices.filter((_, index) => index !== answerIndex)));
  }
  return drafts;
}

async function askGemini(parent: TriviaParent, inputs: TriviaInputs, count: number): Promise<Draft[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("Trivia: GEMINI_API_KEY is not set, using backup questions");
    return [];
  }

  const client = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt(parent, inputs, count);
  const deadline = Date.now() + GEMINI_TIME_LIMIT_MS;

  for (const model of GEMINI_MODELS) {
    const timeLeft = deadline - Date.now();
    if (timeLeft < 1000) break;
    try {
      const response = await withTimeLimit(
        client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: triviaJsonSchema,
            temperature: 0.9,
            abortSignal: AbortSignal.timeout(timeLeft),
          },
        }),
        timeLeft,
      );
      const drafts = parseGeminiTrivia(response.text, inputs.recentQuestions);
      if (drafts.length > 0) return drafts;
      console.warn(`Trivia: ${model} gave no usable questions`);
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : "unknown error").replaceAll(apiKey, "[redacted]");
      console.warn(`Trivia: ${model} failed (${message})`);
    }
  }
  return [];
}

// ---------------------------------------------------------------------
// 3. Backup interest questions (used when Gemini is off, slow or wrong)
// ---------------------------------------------------------------------

interface BackupQuestion {
  topic: string;
  question: string;
  answer: string;
  wrong: [string, string, string];
}

// Which words in her background point to which backup topic.
// Each one matches the start of a word: "garden" also matches "gardening".
const BACKUP_TOPIC_WORDS: Record<string, string[]> = {
  Gardening: ["garden", "flower", "plant", "rose", "tomato", "vegetable"],
  Motown: ["motown", "soul music", "r&b", "doo-wop"],
  "Country music": ["country music", "country western", "bluegrass", "nashville", "grand ole opry"],
  Mysteries: ["myster", "detective", "novel", "book", "reading", "librar"],
  Baking: ["bak", "pie", "cake", "cookie", "bread", "dessert"],
  History: ["histor", "world war", "ww1", "wwi", "veteran", "military", "soldier"],
  Choir: ["choir", "church", "hymn", "gospel", "singing", "sings", "singer"],
  Nursing: ["nurse", "nursing", "hospital"],
};

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}`).test(text);
}

const BACKUP_QUESTIONS: BackupQuestion[] = [
  { topic: "Gardening", question: "Which flower is famous for turning its face toward the sun?", answer: "Sunflower", wrong: ["Rose", "Tulip", "Daisy"] },
  { topic: "Gardening", question: "What do bees collect from flowers to make honey?", answer: "Nectar", wrong: ["Seeds", "Leaves", "Rainwater"] },
  { topic: "Gardening", question: "The tomato is in the same plant family as which vegetable?", answer: "Potato", wrong: ["Carrot", "Lettuce", "Onion"] },
  { topic: "Gardening", question: "Which flower is the Netherlands most famous for?", answer: "Tulip", wrong: ["Rose", "Sunflower", "Daisy"] },
  { topic: "Gardening", question: "Which herb is the main ingredient in classic Italian pesto?", answer: "Basil", wrong: ["Mint", "Rosemary", "Dill"] },
  { topic: "Gardening", question: "How do earthworms help a garden?", answer: "They loosen and enrich the soil", wrong: ["They eat harmful bugs", "They pollinate flowers", "They scare away birds"] },

  { topic: "Motown", question: "In which city was Motown Records founded?", answer: "Detroit", wrong: ["Chicago", "Memphis", "Philadelphia"] },
  { topic: "Motown", question: "Who founded Motown Records?", answer: "Berry Gordy", wrong: ["Smokey Robinson", "Quincy Jones", "Ray Charles"] },
  { topic: "Motown", question: "Which group sang \"My Girl\"?", answer: "The Temptations", wrong: ["The Supremes", "The Four Tops", "The Jackson 5"] },
  { topic: "Motown", question: "Diana Ross first became famous as the lead singer of which group?", answer: "The Supremes", wrong: ["The Marvelettes", "The Ronettes", "Martha and the Vandellas"] },
  { topic: "Motown", question: "Who had a 1968 hit with \"I Heard It Through the Grapevine\"?", answer: "Marvin Gaye", wrong: ["Stevie Wonder", "Otis Redding", "Sam Cooke"] },
  { topic: "Motown", question: "Which Motown group sang \"Reach Out I'll Be There\"?", answer: "The Four Tops", wrong: ["The Temptations", "The Miracles", "The Supremes"] },
  { topic: "Motown", question: "What was the Jackson 5's first No. 1 hit?", answer: "I Want You Back", wrong: ["ABC", "Dancing Machine", "Rockin' Robin"] },
  { topic: "Motown", question: "About how old was Stevie Wonder when he signed with Motown?", answer: "11", wrong: ["16", "19", "21"] },
  { topic: "Motown", question: "Smokey Robinson was the lead singer of which Motown group?", answer: "The Miracles", wrong: ["The Temptations", "The Contours", "The Four Tops"] },

  { topic: "History", question: "In what year did World War I begin?", answer: "1914", wrong: ["1912", "1916", "1918"] },
  { topic: "History", question: "World War I ended with an armistice on November 11 of which year?", answer: "1918", wrong: ["1917", "1919", "1920"] },
  { topic: "History", question: "Archduke Franz Ferdinand's assassination started World War I. Which empire was he from?", answer: "Austria-Hungary", wrong: ["Germany", "Russia", "Serbia"] },
  { topic: "History", question: "Which red flower became a symbol for remembering World War I soldiers?", answer: "The poppy", wrong: ["The rose", "The tulip", "The carnation"] },
  { topic: "History", question: "In what year did the United States enter World War I?", answer: "1917", wrong: ["1914", "1915", "1918"] },
  { topic: "History", question: "Who was the U.S. President during World War I?", answer: "Woodrow Wilson", wrong: ["Theodore Roosevelt", "Franklin D. Roosevelt", "Herbert Hoover"] },
  { topic: "History", question: "November 11 was first called Armistice Day. What is it called in the U.S. today?", answer: "Veterans Day", wrong: ["Memorial Day", "Labor Day", "Flag Day"] },

  { topic: "Choir", question: "In a choir, which voice part sings the highest notes?", answer: "Soprano", wrong: ["Alto", "Tenor", "Bass"] },
  { topic: "Choir", question: "How many singers are in a quartet?", answer: "Four", wrong: ["Three", "Five", "Six"] },
  { topic: "Choir", question: "Who wrote the words to the hymn \"Amazing Grace\"?", answer: "John Newton", wrong: ["Charles Wesley", "Isaac Watts", "Fanny Crosby"] },

  { topic: "Nursing", question: "Which nurse was known as \"The Lady with the Lamp\"?", answer: "Florence Nightingale", wrong: ["Clara Barton", "Mary Seacole", "Dorothea Dix"] },
  { topic: "Nursing", question: "Who founded the American Red Cross?", answer: "Clara Barton", wrong: ["Florence Nightingale", "Eleanor Roosevelt", "Susan B. Anthony"] },

  { topic: "Country music", question: "Who sang \"Stand by Your Man\"?", answer: "Tammy Wynette", wrong: ["Dolly Parton", "Loretta Lynn", "Patsy Cline"] },
  { topic: "Country music", question: "Which singer is known as the \"Coal Miner's Daughter\"?", answer: "Loretta Lynn", wrong: ["Tammy Wynette", "Dolly Parton", "June Carter"] },
  { topic: "Country music", question: "Patsy Cline had a famous hit with which song?", answer: "Crazy", wrong: ["Jolene", "Ring of Fire", "Stand by Your Man"] },
  { topic: "Country music", question: "Which country star was called \"The Man in Black\"?", answer: "Johnny Cash", wrong: ["Willie Nelson", "Merle Haggard", "Hank Williams"] },
  { topic: "Country music", question: "Which city is home to the Grand Ole Opry?", answer: "Nashville", wrong: ["Memphis", "Austin", "Branson"] },
  { topic: "Country music", question: "What is the name of Dolly Parton's theme park in Tennessee?", answer: "Dollywood", wrong: ["Graceland", "Opryland", "Silver Dollar City"] },

  { topic: "Mysteries", question: "Which author created the detective Hercule Poirot?", answer: "Agatha Christie", wrong: ["Dorothy L. Sayers", "Arthur Conan Doyle", "Raymond Chandler"] },
  { topic: "Mysteries", question: "What is the name of Agatha Christie's village detective who is an elderly lady?", answer: "Miss Marple", wrong: ["Miss Havisham", "Mrs. Hudson", "Miss Jean Brodie"] },
  { topic: "Mysteries", question: "Sherlock Holmes lived at which address?", answer: "221B Baker Street", wrong: ["10 Downing Street", "7 Savile Row", "1 Abbey Road"] },
  { topic: "Mysteries", question: "The Nancy Drew books were written under which pen name?", answer: "Carolyn Keene", wrong: ["Franklin W. Dixon", "Laura Lee Hope", "Ann M. Martin"] },
  { topic: "Mysteries", question: "Who wrote the Perry Mason mysteries?", answer: "Erle Stanley Gardner", wrong: ["Rex Stout", "Mickey Spillane", "Dashiell Hammett"] },

  { topic: "Baking", question: "What makes bread dough rise?", answer: "Yeast", wrong: ["Salt", "Butter", "Flour"] },
  { topic: "Baking", question: "Besides sugar, what is the main ingredient in meringue?", answer: "Egg whites", wrong: ["Egg yolks", "Butter", "Flour"] },
  { topic: "Baking", question: "What do you call a cake baked in a ring-shaped pan with a hole in the middle?", answer: "Bundt cake", wrong: ["Sheet cake", "Layer cake", "Cupcake"] },
  { topic: "Baking", question: "Snickerdoodle cookies are rolled in sugar and which spice?", answer: "Cinnamon", wrong: ["Nutmeg", "Ginger", "Cloves"] },

  { topic: "General", question: "What is the largest ocean on Earth?", answer: "The Pacific", wrong: ["The Atlantic", "The Indian", "The Arctic"] },
  { topic: "General", question: "How many states are in the United States?", answer: "50", wrong: ["48", "49", "52"] },
  { topic: "General", question: "Which planet is known as the Red Planet?", answer: "Mars", wrong: ["Venus", "Jupiter", "Saturn"] },
  { topic: "General", question: "In the 1939 film \"The Wizard of Oz\", what color are Dorothy's slippers?", answer: "Ruby red", wrong: ["Silver", "Gold", "Blue"] },
  { topic: "General", question: "Who was the first person to walk on the Moon?", answer: "Neil Armstrong", wrong: ["Buzz Aldrin", "John Glenn", "Yuri Gagarin"] },
  { topic: "General", question: "How many days are in a leap year?", answer: "366", wrong: ["364", "365", "367"] },
  { topic: "General", question: "What is the capital of Canada?", answer: "Ottawa", wrong: ["Toronto", "Montreal", "Vancouver"] },
  { topic: "General", question: "What is the tallest mountain in the world?", answer: "Mount Everest", wrong: ["K2", "Kilimanjaro", "Mont Blanc"] },
];

// Her topics first (taking turns between them), then general, then the rest.
// Skips anything already used; recently asked questions go last.
export function pickBackupQuestions(count: number, interestText: string, avoid: Set<string>): Draft[] {
  const text = interestText.toLowerCase();
  const wanted = Object.keys(BACKUP_TOPIC_WORDS).filter((topic) =>
    BACKUP_TOPIC_WORDS[topic].some((word) => mentions(text, word)),
  );

  const queues = wanted.map((topic) => shuffle(BACKUP_QUESTIONS.filter((q) => q.topic === topic)));
  const ordered: BackupQuestion[] = [];
  while (queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) ordered.push(next);
    }
  }
  ordered.push(...shuffle(BACKUP_QUESTIONS.filter((q) => q.topic === "General")));
  ordered.push(...shuffle(BACKUP_QUESTIONS.filter((q) => q.topic !== "General" && !wanted.includes(q.topic))));

  const fresh = ordered.filter((q) => !avoid.has(normalize(q.question)));
  return fresh
    .slice(0, count)
    .map((q) => makeDraft(q.topic, q.question, q.answer, q.wrong));
}

// ---------------------------------------------------------------------
// 4. Put the 10 questions together
// ---------------------------------------------------------------------

// "A few questions ago you were asked ... What was the right answer?"
function recallQuestion(n: number, earlier: TriviaQuestion): TriviaQuestion {
  const correct = earlier.choices[earlier.answerIndex];
  const choices = shuffle(earlier.choices);
  return {
    n,
    kind: "recall",
    topic: "Short-term memory",
    question: `A few questions ago you were asked: “${earlier.question}” What was the right answer?`,
    choices,
    answerIndex: choices.indexOf(correct),
  };
}

export async function buildTrivia(parent: TriviaParent): Promise<Trivia> {
  const inputs = await loadInputs(parent.id);

  // Up to 3 memory questions: 2 facts + the appointment, or 3 facts.
  const memory = inputs.appointment
    ? [...inputs.facts.slice(0, 2), inputs.appointment]
    : inputs.facts.slice(0, 3);
  const interestNeeded = TOTAL_QUESTIONS - MEMORY_SLOTS.size + (memory.length === 0 ? 1 : 0);

  // Interest questions: Gemini first (a few extra in case some are bad), then backup.
  const avoid = new Set([...inputs.recentQuestions, ...memory.map((draft) => normalize(draft.question))]);
  const fromGemini = (await askGemini(parent, { ...inputs, recentQuestions: avoid }, interestNeeded + 2))
    .slice(0, interestNeeded);
  for (const draft of fromGemini) avoid.add(normalize(draft.question));
  const interestText = [parent.background_notes ?? "", ...inputs.topics].join(" ");
  const fromBackup = pickBackupQuestions(interestNeeded - fromGemini.length, interestText, avoid);
  const interest = [...fromGemini, ...fromBackup];

  // If recent games used up the backup list, allow repeats rather than fail.
  if (interest.length < interestNeeded) {
    interest.push(...pickBackupQuestions(interestNeeded - interest.length, interestText,
      new Set(interest.map((draft) => normalize(draft.question)))));
  }

  const questions: TriviaQuestion[] = [];
  for (let n = 1; n <= TOTAL_QUESTIONS; n += 1) {
    if (MEMORY_SLOTS.has(n)) {
      const personal = memory.shift();
      if (personal) {
        questions.push({ n, kind: "memory", ...personal });
        continue;
      }
      const earlier = questions[n - 3]; // the question 2 before this one
      if (n !== 1 && earlier?.kind === "interest") {
        questions.push(recallQuestion(n, earlier));
        continue;
      }
    }
    const next = interest.shift();
    if (!next) throw new Error("Could not build enough trivia questions");
    questions.push({ n, kind: "interest", ...next });
  }

  const source = fromGemini.length === 0 ? "backup" : fromGemini.length === interestNeeded ? "gemini" : "mixed";
  return { questions, source };
}
