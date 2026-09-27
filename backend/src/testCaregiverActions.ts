import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool } from "./db.js";
import { createCaregiverAction, listCaregiverActions } from "./services/caregiverActions.js";
import { parseScheduledFields } from "./app.js";

// DB-backed tests use synthetic, clearly-marked ("ZZTEST ...") rows against the
// existing susan.demo@ypia.test parent (and one unrelated parent for the
// cross-parent authorization check), and clean up everything they insert.

let failures = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`passed: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`failed: ${name}`);
    console.error(error);
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`passed: ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`failed: ${name}`);
    console.error(error);
  }
}

const noSchedule = { scheduledDate: null, scheduledTime: null, scheduledEndTime: null };

// --- Pure validation tests (no DB) ---

test("validation: time without date is rejected", () => {
  const result = parseScheduledFields({ scheduledTime: "09:00" });
  assert.equal(typeof result, "string");
});

test("validation: endTime without time is rejected", () => {
  const result = parseScheduledFields({ scheduledDate: "2026-09-28", scheduledEndTime: "10:00" });
  assert.equal(typeof result, "string");
});

test("validation: invalid date is rejected", () => {
  const result = parseScheduledFields({ scheduledDate: "2026-02-30" });
  assert.equal(typeof result, "string");
});

test("validation: malformed date string is rejected", () => {
  const result = parseScheduledFields({ scheduledDate: "September 28" });
  assert.equal(typeof result, "string");
});

test("validation: invalid time is rejected", () => {
  const result = parseScheduledFields({ scheduledDate: "2026-09-28", scheduledTime: "9:00 AM" });
  assert.equal(typeof result, "string");
});

test("validation: endTime earlier than time is rejected", () => {
  const result = parseScheduledFields({ scheduledDate: "2026-09-28", scheduledTime: "10:00", scheduledEndTime: "09:00" });
  assert.equal(typeof result, "string");
});

test("validation: a valid date+time+endTime passes through unchanged", () => {
  const result = parseScheduledFields({ scheduledDate: "2026-09-28", scheduledTime: "09:00", scheduledEndTime: "10:00" });
  assert.deepEqual(result, { scheduledDate: "2026-09-28", scheduledTime: "09:00", scheduledEndTime: "10:00" });
});

test("validation: nothing supplied yields all nulls, not an error", () => {
  const result = parseScheduledFields({});
  assert.deepEqual(result, { scheduledDate: null, scheduledTime: null, scheduledEndTime: null });
});

// --- DB-backed integration tests ---

async function main() {
  if (process.argv.includes("--offline")) {
    console.log("Offline mode: database-backed integration tests skipped.");
    process.exitCode = failures > 0 ? 1 : 0;
    return;
  }

  const pool = getPool();

  const susan = await pool.query<{ user_id: string; parent_id: string }>(
    "SELECT u.id as user_id, p.id as parent_id FROM users u JOIN parents p ON p.user_id = u.id WHERE u.email = 'susan.demo@ypia.test'"
  );
  const otherParent = await pool.query<{ parent_id: string }>(
    "SELECT p.id as parent_id FROM users u JOIN parents p ON p.user_id = u.id WHERE u.email = 'test@gmail.com'"
  );

  if (susan.rows.length === 0 || otherParent.rows.length === 0) {
    console.log("Required synthetic demo accounts not found — skipping caregiver-action tests.");
    return;
  }

  const { user_id: susanUserId, parent_id: susanParentId } = susan.rows[0];
  const otherParentId = otherParent.rows[0].parent_id;

  const createdAppointmentIds: string[] = [];
  const createdActionIds: string[] = [];

  async function insertAppointment(parentId: string, title: string, startsAt: string, timezone = "America/Chicago") {
    const id = randomUUID();
    createdAppointmentIds.push(id);
    await pool.query(
      `INSERT INTO appointments (id, parent_id, title, starts_at, timezone, status)
       VALUES ($1, $2, $3, $4, $5, 'confirmed')`,
      [id, parentId, title, startsAt, timezone]
    );
    return id;
  }

  async function cleanup() {
    if (createdActionIds.length > 0) {
      await pool.query("DELETE FROM caregiver_actions WHERE id = ANY($1::text[])", [createdActionIds]);
      createdActionIds.length = 0;
    }
    if (createdAppointmentIds.length > 0) {
      await pool.query("DELETE FROM appointments WHERE id = ANY($1::text[])", [createdAppointmentIds]);
      createdAppointmentIds.length = 0;
    }
  }

  try {
    await asyncTest("1: a valid appointmentId belonging to the parent is stored", async () => {
      const apptId = await insertAppointment(susanParentId, "ZZTEST Cardiology Follow-Up", "2026-10-14T19:30:00Z");
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Please take Susan to her appointment",
        conversationId: null,
        appointmentId: apptId,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const row = await pool.query("SELECT appointment_id FROM caregiver_actions WHERE id = $1", [action.id]);
      assert.equal(row.rows[0].appointment_id, apptId);
    });
    await cleanup();

    await asyncTest("2: an appointment belonging to another parent cannot be linked", async () => {
      const otherAppointmentId = await insertAppointment(otherParentId, "ZZTEST Unrelated Appointment", "2026-11-01T15:00:00Z");
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST cross-parent link attempt",
        conversationId: null,
        appointmentId: otherAppointmentId,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const row = await pool.query("SELECT appointment_id FROM caregiver_actions WHERE id = $1", [action.id]);
      assert.equal(row.rows[0].appointment_id, null, "action must be created, but without the untrusted link");
    });
    await cleanup();

    await asyncTest("3: a nonexistent appointmentId cannot become trusted calendar metadata", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST bogus appointment reference",
        conversationId: null,
        appointmentId: randomUUID(),
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, null);
      assert.equal(listed.time, null);
    });
    await cleanup();

    await asyncTest("4: a linked caregiver action exposes the authoritative appointment date/time", async () => {
      const apptId = await insertAppointment(susanParentId, "ZZTEST Cardiology Follow-Up", "2026-10-14T19:30:00Z");
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Please take Susan to her appointment",
        conversationId: null,
        appointmentId: apptId,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-10-14");
      assert.equal(listed.time, "2:30 PM");
    });
    await cleanup();

    await asyncTest("5: conflicting action_text date/time cannot override the stored appointment", async () => {
      const apptId = await insertAppointment(susanParentId, "ZZTEST Cardiology Follow-Up", "2026-10-14T19:30:00Z");
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Susan's appointment is actually on January 1, 2099 at 11:59 PM",
        conversationId: null,
        appointmentId: apptId,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-10-14");
      assert.equal(listed.time, "2:30 PM");
    });
    await cleanup();

    await asyncTest("6: an unrelated voice action with no appointmentId remains undated", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Susan wants to go to the park",
        conversationId: null,
        appointmentId: null,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, null);
      assert.equal(listed.time, null);
    });
    await cleanup();

    await asyncTest("7: a date-only appointment (stored midnight) exposes date without a time", async () => {
      const apptId = await insertAppointment(
        susanParentId,
        "ZZTEST Lab Work",
        "2026-11-05T06:00:00Z" // midnight local in America/Chicago (standard time)
      );
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Susan has lab work",
        conversationId: null,
        appointmentId: apptId,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-11-05");
      assert.equal(listed.time, null, "midnight-local must not be exposed as an invented time");
    });
    await cleanup();

    await asyncTest("8: existing manually-created/unlinked actions are unaffected", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST manual reminder with no appointment link",
        conversationId: null,
        appointmentId: null,
        ...noSchedule,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, null);
      assert.equal(listed.time, null);
      assert.equal(listed.text, "ZZTEST manual reminder with no appointment link");
    });
    await cleanup();

    await asyncTest("9: a general action with explicit date+time stores and exposes structured values", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Take Susan to the park",
        conversationId: null,
        appointmentId: null,
        scheduledDate: "2026-09-28",
        scheduledTime: "09:00",
        scheduledEndTime: null,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-09-28");
      assert.equal(listed.time, "09:00");
      assert.equal(listed.endTime, null);
    });
    await cleanup();

    await asyncTest("10: a general date-only action exposes date without a time (all-day)", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Remind Mike about the family dinner",
        conversationId: null,
        appointmentId: null,
        scheduledDate: "2026-10-05",
        scheduledTime: null,
        scheduledEndTime: null,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-10-05");
      assert.equal(listed.time, null);
    });
    await cleanup();

    await asyncTest("11: appointmentId overrides conflicting scheduledDate/scheduledTime", async () => {
      const apptId = await insertAppointment(susanParentId, "ZZTEST Cardiology Follow-Up", "2026-10-14T19:30:00Z");
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Take Susan to her cardiology appointment",
        conversationId: null,
        appointmentId: apptId,
        scheduledDate: "2099-01-01",
        scheduledTime: "23:59",
        scheduledEndTime: null,
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-10-14", "the linked appointment must win over conflicting scheduled_* values");
      assert.equal(listed.time, "2:30 PM");
    });
    await cleanup();

    await asyncTest("12: a general action with an explicit endTime exposes it for the calendar export", async () => {
      const action = await createCaregiverAction({
        parentId: susanParentId,
        createdByUserId: susanUserId,
        text: "ZZTEST Take Susan to the park",
        conversationId: null,
        appointmentId: null,
        scheduledDate: "2026-09-28",
        scheduledTime: "09:00",
        scheduledEndTime: "10:30",
      });
      createdActionIds.push(action.id);

      const [listed] = (await listCaregiverActions([susanParentId])).filter((a) => a.id === action.id);
      assert.equal(listed.date, "2026-09-28");
      assert.equal(listed.time, "09:00");
      assert.equal(listed.endTime, "10:30");
    });
    await cleanup();
  } finally {
    await cleanup();
  }

  await pool.end();

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All caregiver-action tests passed.");
  }
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
