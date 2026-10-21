// Applies db/migrations/*.sql in order. Usage: DATABASE_URL=... npm run db:migrate
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== "1" };
const client = new pg.Client({ connectionString: url, ssl });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
const dir = path.join(import.meta.dirname, "..", "db", "migrations");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const done = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
  if (done.rowCount) continue;
  await client.query("BEGIN");
  try {
    await client.query(readFileSync(path.join(dir, file), "utf8"));
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log("applied", file);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("failed", file, e.message);
    process.exit(1);
  }
}
await client.end();
console.log("migrations up to date");
