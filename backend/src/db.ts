import { Pool } from "pg";
import type { PoolConfig } from "pg";

function buildPoolConfig(): PoolConfig {
  let connectionString = process.env.TIMESCALE_SERVICE_URL ?? process.env.DATABASE_URL;

  if (connectionString) {
    try {
      const url = new URL(connectionString);
      url.search = "";
      connectionString = url.toString();
    } catch {
      // Not a standard URI — leave connectionString as-is.
    }

    return {
      connectionString,
      ssl: { rejectUnauthorized: false }
    };
  }

  if (process.env.PGHOST) {
    return {
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: Number(process.env.PGPORT ?? 36304),
      ssl: { rejectUnauthorized: false }
    };
  }

  throw new Error(
    "Neither TIMESCALE_SERVICE_URL nor PGHOST found in environment. " +
      "Add your Tiger Cloud connection details to backend/.env"
  );
}

export const pool = new Pool(buildPoolConfig());