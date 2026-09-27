import assert from "node:assert/strict";
import { getPool } from "./db.js";
import { getParentIdForUser, getNextAppointment } from "./services/parentInfo.js";
import {
  getParentBackground,
  getParentSchedule,
  isValidScheduleRange,
  resolveTimezone,
} from "./services/parentContext.js";

// Read-only tests against existing synthetic/seed data only:
// - the schedule_seed.sql demo parent (rich background + Whiskers vet event, no appointments row)
// - our own susan.demo@ypia.test demo parent (now also carries a copy of that same background
//   + schedule, so it's checked for populated data rather than as an "empty" control)
// - test1@gmail.com's parent (genuinely empty background/schedule — the "no data" control)
// Nothing is inserted, modified, or deleted.

const SEED_USER_ID = "f5062b07-eb3e-4edc-bf5f-d0e28c6e6ac8"; // parent@gmail.com
const SEED_PARENT_ID = "3c8bb77b-bdf6-444d-a656-ca8046e766b3";
const TIMEZONE = "America/Chicago";

let failures = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`passed: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`failed: ${name}`);
    console.error(error);
  }
}

function assertChronological(events: { startTime: string }[]) {
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(
      new Date(events[i - 1].startTime).getTime() <= new Date(events[i].startTime).getTime(),
      "events must be ordered chronologically"
    );
  }
}

function assertNoPointFields(events: unknown[]) {
  events.forEach((event) => {
    const record = event as Record<string, unknown>;
    assert.equal(record.pointValue, undefined);
    assert.equal(record.pointsEarned, undefined);
    assert.equal(record.pointsReview, undefined);
    assert.equal(record.point_value, undefined);
    assert.equal(record.points_earned, undefined);
    assert.equal(record.points_review, undefined);
  });
}

async function main() {
  const pool = getPool();
  const seedUser = await pool.query("SELECT id FROM users WHERE id = $1", [SEED_USER_ID]);
  const susanUser = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = 'susan.demo@ypia.test'"
  );
  const emptyControlUser = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = 'test1@gmail.com'"
  );

  if (seedUser.rows.length === 0 || susanUser.rows.length === 0 || emptyControlUser.rows.length === 0) {
    console.log("Required synthetic/seed accounts not found — skipping.");
    await pool.end();
    return;
  }
  const susanUserId = susanUser.rows[0].id;
  const emptyControlUserId = emptyControlUser.rows[0].id;

  await test("resolves the seed demo parent identity correctly", async () => {
    const parentId = await getParentIdForUser(SEED_USER_ID);
    assert.equal(parentId, SEED_PARENT_ID);
  });

  await test("range validation accepts only the four allowed values", async () => {
    assert.equal(isValidScheduleRange("today"), true);
    assert.equal(isValidScheduleRange("tomorrow"), true);
    assert.equal(isValidScheduleRange("week"), true);
    assert.equal(isValidScheduleRange("upcoming"), true);
    assert.equal(isValidScheduleRange("nextyear"), false);
    assert.equal(isValidScheduleRange(""), false);
    assert.equal(isValidScheduleRange(undefined), false);
  });

  await test("timezone resolution falls back for missing/invalid values only", async () => {
    assert.equal(resolveTimezone("America/Chicago"), "America/Chicago");
    assert.equal(resolveTimezone("Europe/London"), "Europe/London");
    assert.equal(resolveTimezone("Not/AZone"), "America/Chicago");
    assert.equal(resolveTimezone(undefined), "America/Chicago");
    assert.equal(resolveTimezone(""), "America/Chicago");
  });

  await test("background retrieval returns live data for the seed parent (content not logged)", async () => {
    const background = await getParentBackground(SEED_PARENT_ID);
    assert.ok(background);
    assert.equal(background?.status, "ok");
    assert.equal(background?.name, "Saturday");
    assert.ok(typeof background?.background === "string" && background.background.length > 0);
  });

  await test("background retrieval is 'none' for a parent with no notes (no fabrication)", async () => {
    const emptyParentId = await getParentIdForUser(emptyControlUserId);
    assert.ok(emptyParentId);
    const background = await getParentBackground(emptyParentId as string);
    assert.equal(background?.status, "none");
    assert.equal(background?.background, null);
  });

  await test("demo Susan now carries the copied background and schedule (content not logged)", async () => {
    const susanParentId = await getParentIdForUser(susanUserId);
    assert.ok(susanParentId);

    const background = await getParentBackground(susanParentId as string);
    assert.equal(background?.status, "ok");
    assert.ok(typeof background?.background === "string" && background.background.length > 0);

    const upcoming = await getParentSchedule(susanParentId as string, "upcoming", TIMEZONE);
    assert.ok(upcoming.length > 0);
  });

  await test("schedule 'week'/'upcoming' are bounded, chronological, and carry no point fields", async () => {
    const week = await getParentSchedule(SEED_PARENT_ID, "week", TIMEZONE);
    assert.ok(week.length <= 15);
    assertChronological(week);
    assertNoPointFields(week);

    const upcoming = await getParentSchedule(SEED_PARENT_ID, "upcoming", TIMEZONE);
    assert.ok(upcoming.length <= 15);
    assertChronological(upcoming);
    assertNoPointFields(upcoming);
  });

  await test("schedule 'today'/'tomorrow' resolve without error (may legitimately be empty)", async () => {
    const today = await getParentSchedule(SEED_PARENT_ID, "today", TIMEZONE);
    const tomorrow = await getParentSchedule(SEED_PARENT_ID, "tomorrow", TIMEZONE);
    assert.ok(Array.isArray(today));
    assert.ok(Array.isArray(tomorrow));
  });

  await test("no cross-parent leakage: an unrelated parent sees no schedule/background data", async () => {
    const emptyParentId = await getParentIdForUser(emptyControlUserId);
    const events = await getParentSchedule(emptyParentId as string, "upcoming", TIMEZONE);
    assert.deepEqual(events, []);
  });

  await test("Whiskers' vet visit exists in the raw schedule and is categorized as a normal event", async () => {
    const result = await pool.query<{ title: string; category: string }>(
      "SELECT title, category FROM schedule WHERE parent_id = $1 AND title ILIKE '%Whiskers%'",
      [SEED_PARENT_ID]
    );
    assert.ok(result.rows.length > 0, "expected a Whiskers event in the seed schedule");
    assert.equal(result.rows[0].category, "Medical");
  });

  await test("get_next_appointment stays appointments-only and does NOT fall back to the Medical-category Whiskers event", async () => {
    const apptCount = await pool.query("SELECT count(*) FROM appointments WHERE parent_id = $1", [
      SEED_PARENT_ID,
    ]);
    assert.equal(apptCount.rows[0].count, "0", "this seed parent should have zero appointments rows");

    const nextAppointment = await getNextAppointment(SEED_PARENT_ID);
    assert.equal(nextAppointment, null, "must be null, not the Whiskers schedule event");
  });

  await pool.end();

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All parent-context tests passed.");
  }
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
