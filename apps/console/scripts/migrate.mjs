import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertKnownMigrationLedger, enforceMigrationLedgerIntegrity, ensureMigrationLedger, loadMigrations, migrationLockName } from "./migration-integrity.mjs";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(scriptDirectory, "../../../infra/postgres/migrations");
const migrations = await loadMigrations(migrationsDirectory);
const client = new Client({ connectionString: databaseUrl });

await client.connect();
let lockAcquired = false;
try {
  const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [migrationLockName]);
  if (lock.rows[0]?.acquired !== true) throw new Error("another schema migration is already running");
  lockAcquired = true;

  await ensureMigrationLedger(client);
  const appliedRows = (await client.query("select name, checksum from schema_migrations order by name")).rows;
  assertKnownMigrationLedger(appliedRows, migrations);
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query("insert into schema_migrations(name, checksum) values ($1, $2)", [migration.name, migration.checksum]);
      await client.query("commit");
      console.log(`Applied ${migration.name} (${migration.checksum})`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  await enforceMigrationLedgerIntegrity(client);
} finally {
  if (lockAcquired) await client.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]).catch(() => undefined);
  await client.end();
}
