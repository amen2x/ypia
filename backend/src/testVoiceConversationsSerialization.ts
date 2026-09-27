import assert from "node:assert/strict";
import { prepareJsonbParam } from "./services/voiceConversations.js";

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

test("a top-level transcript array is stringified, not passed as a raw array", () => {
  const transcript = [
    { role: "user", message: "test" },
    { role: "agent", message: "test response" },
  ];

  const param = prepareJsonbParam(transcript);

  assert.equal(typeof param, "string");
  assert.notEqual(param, transcript as unknown);
});

test("the prepared param round-trips back to an equivalent array via JSON.parse", () => {
  const transcript = [
    { role: "user", message: "test" },
    { role: "agent", message: "test response" },
  ];

  const param = prepareJsonbParam(transcript);
  const roundTripped = JSON.parse(param as string);

  assert.equal(Array.isArray(roundTripped), true);
  assert.equal(roundTripped.length, 2);
  assert.deepEqual(
    roundTripped.map((entry: { role: string }) => entry.role),
    ["user", "agent"]
  );
});

test("the prepared param is not double-encoded", () => {
  const transcript = [{ role: "user", message: "test" }];
  const param = prepareJsonbParam(transcript);
  const parsedOnce = JSON.parse(param as string);

  // Double-encoding would make parsedOnce a string, not the array itself.
  assert.equal(Array.isArray(parsedOnce), true);
});

test("null/undefined transcript stays null so COALESCE keeps the existing DB value", () => {
  assert.equal(prepareJsonbParam(null), null);
  assert.equal(prepareJsonbParam(undefined), null);
});

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All voice-conversation serialization tests passed.");
}
