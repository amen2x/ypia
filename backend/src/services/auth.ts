import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";

const SALT_ROUNDS = 12;

export class AuthError extends Error {}

export interface SignupInput {
  role: "parent" | "child";
  fullName: string;
  email: string;
  password: string;
  parentEmail?: string;
  relationship?: string;
}

export async function createAccount(input: SignupInput): Promise<{ userId: string }> {
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

      const parentLookup = await client.query(
        `SELECT p.id
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
): Promise<{ id: string; fullName: string }> {
  const result = await pool.query(
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

  return { id: user.id, fullName: user.full_name };
}