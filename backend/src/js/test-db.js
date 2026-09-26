require('dotenv').config({ path: './tiger-cloud-tigerhacks2026-credentials.env' });
const { Pool } = require('pg');

let connectionString = process.env.TIMESCALE_SERVICE_URL || process.env.DATABASE_URL;
let poolConfig = {};

if (connectionString) {
  // Strip out query parameters like ?sslmode=require to prevent pg from 
  // overriding our custom ssl configuration.
  try {
    const url = new URL(connectionString);
    url.search = ''; 
    connectionString = url.toString();
  } catch (e) {
    // Ignore URL parsing errors if connectionString isn't a standard URI
  }

  poolConfig = {
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  };
} else if (process.env.PGHOST) {
  // Fallback to standard PG environment variables
  poolConfig = {
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT || 36304,
    ssl: { rejectUnauthorized: false }
  };
} else {
  console.error("❌ Error: Neither TIMESCALE_SERVICE_URL nor PGHOST found in environment file.");
  process.exit(1);
}

const pool = new Pool(poolConfig);

async function testConnection() {
  try {
    console.log("Connecting to Tiger Cloud TimescaleDB instance...");
    const result = await pool.query('SELECT NOW() AS current_time, version() AS db_version;');
    
    console.log("✅ Successfully connected to Tiger Data!");
    console.log("-----------------------------------------");
    console.log("Server Time:", result.rows[0].current_time);
    console.log("Database Version:", result.rows[0].db_version);
    console.log("-----------------------------------------");
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
  } finally {
    await pool.end();
  }
}

testConnection();