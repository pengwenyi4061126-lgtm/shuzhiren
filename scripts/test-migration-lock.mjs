import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to test migration locking");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrator = path.join(root, "apps", "console", "scripts", "migrate.mjs");
const migrationLockName = "shuzhiren-schema-migrations";
const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();
try {
  const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [migrationLockName]);
  assert.equal(lock.rows[0]?.acquired, true, "test fixture must acquire the migration advisory lock");

  const result = spawnSync(process.execPath, [migrator], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "a concurrent migration must fail instead of racing schema_migrations");
  assert.match(`${result.stderr}${result.stdout}`, /another schema migration is already running/);
} finally {
  await client.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]).catch(() => undefined);
  await client.end();
}

console.log("PASS  concurrent PostgreSQL migration attempts fail before schema changes");
