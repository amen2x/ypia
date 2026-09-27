import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { getPool } from "../db.js";

const SALT_ROUNDS = 12;

export class AuthError extends Error {}

export type AccountRole = "parent" | "caregiver";

export interface SignupInput {
  role: "parent" | "child";
  fullName: string;
  email: string;
  password: string;
  parentEmail?: string;
  relationship?: string;
}

export async function createAccount(input: SignupInput): Promise<{ userId: string }> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT id FROM users WHERE email = $1", [input.email]);
    if (existing.rows.length > 0) {
      throw new AuthError("An account with that email already exists");
    }

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const userId = randomUUID();

    await client.query(
      "INSERT INTO users (id, full_name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [userId, input.fullName, input.email, passwordHash]
    );

    if (input.role === "parent") {
      const parentId = randomUUID();
      await client.query(
        "INSERT INTO parents (id, full_name, user_id) VALUES ($1, $2, $3)",
        [parentId, input.fullName, userId]
      );
    } else {
      if (!input.parentEmail) {
        throw new AuthError("parentEmail is required for a child account");
      }

      const parentLookup = await client.query<{ id: string; user_id: string }>(
        `SELECT p.id, p.user_id
         FROM parents p
         JOIN users u ON u.id = p.user_id
         WHERE u.email = $1`,
        [input.parentEmail]
      );

      if (parentLookup.rows.length === 0) {
        throw new AuthError("No parent account found with that email");
      }

      await client.query(
        `INSERT INTO parent_relationships (parent_id, user_id, relationship, status)
         VALUES ($1, $2, $3, 'pending')`,
        [parentLookup.rows[0].id, userId, input.relationship ?? "other"]
      );
    }

    await client.query("COMMIT");
    return { userId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyLogin(
  email: string,
  password: string
): Promise<{ id: string; fullName: string; role: AccountRole; parentId: string | null }> {
  const pool = getPool();
  const result = await pool.query<{ id: string; full_name: string; password_hash: string }>(
    "SELECT id, full_name, password_hash FROM users WHERE email = $1",
    [email]
  );

  if (result.rows.length === 0) {
    throw new AuthError("Invalid email or password");
  }

  const user = result.rows[0];
  const matches = await bcrypt.compare(password, user.password_hash);

  if (!matches) {
    throw new AuthError("Invalid email or password");
  }

  const parentRow = await pool.query<{ id: string }>(
    "SELECT id FROM parents WHERE user_id = $1",
    [user.id]
  );

  if (parentRow.rows.length > 0) {
    return { id: user.id, fullName: user.full_name, role: "parent", parentId: parentRow.rows[0].id };
  }

  // Auto-approve on login: if this account has a pending link to a parent,
  // logging in successfully is treated as confirmation and flips it to approved.
    const relationshipRow = await pool.query<{ parent_id: string; parent_user_id: string; status: string }>(
      `SELECT pr.parent_id, p.user_id AS parent_user_id, pr.status
       FROM parent_relationships pr
       JOIN parents p ON p.id = pr.parent_id
       WHERE pr.user_id = $1
       LIMIT 1`,
      [user.id]
    );

  if (relationshipRow.rows.length > 0) {
    const { parent_id: parentId, parent_user_id: parentUserId, status } = relationshipRow.rows[0];

    if (status === "pending") {
      await pool.query(
        `UPDATE parent_relationships
         SET status = 'approved', approved_by = $2, approved_at = NOW()
         WHERE user_id = $1 AND parent_id = $3`,
        [user.id, parentUserId, parentId]
      );
    }

    return { id: user.id, fullName: user.full_name, role: "caregiver", parentId };
  }

  throw new AuthError("Account role could not be determined");
}
