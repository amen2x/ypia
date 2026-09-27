import assert from "node:assert/strict";
import { getPool } from "./db.js";
import { getParentIdForUser } from "./services/parentInfo.js";
import { listSharedDocuments } from "./services/caregiverDocuments.js";

// Read-only authorization check using the existing synthetic demo parent
// (susan.demo@ypia.test). No rows are inserted, modified, or deleted.

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

async function main() {
  const pool = getPool();
  const susanUser = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE email = 'susan.demo@ypia.test'"
  );
  if (susanUser.rows.length === 0) {
    console.log("Synthetic demo parent susan.demo@ypia.test not found — skipping.");
    return;
  }

  const susanParentId = await getParentIdForUser(susanUser.rows[0].id);
  assert.ok(susanParentId, "synthetic demo parent must resolve to a parents.id");

  await test("an authorized caregiver's parent-id list returns Susan's shared documents", async () => {
    const documents = await listSharedDocuments([susanParentId as string]);
    assert.ok(documents.length > 0, "expected at least one document for the demo parent");
    documents.forEach((doc) => {
      assert.equal(doc.parentName, "Susan Carter");
      assert.equal(typeof doc.documentName, "string");
      assert.equal(typeof doc.documentType, "string");
      assert.equal(typeof doc.uploadedAt, "string");
      // Only safe, persisted fields should ever be exposed — no storage_key/file bytes.
      assert.equal((doc as unknown as Record<string, unknown>).storageKey, undefined);
    });
  });

  await test("an unrelated/unauthorized caregiver (empty parent-id list) sees nothing", async () => {
    const documents = await listSharedDocuments([]);
    assert.deepEqual(documents, []);
  });

  await pool.end();

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("All caregiver document authorization tests passed.");
  }
}

main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
