import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertKnownMigrationLedger, enforceMigrationLedgerIntegrity, ensureMigrationLedger, findOutOfOrderMigrations, loadMigrations, migrationFailure, migrationLockName, migrationTimeouts } from "./migration-integrity.mjs";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations");
// Validated before connecting, so an invalid value never takes the advisory lock.
const timeouts = migrationTimeouts(process.env);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
// --migrations-dir exists for the migrator tests only; the production command never passes it.
const migrationsDirectoryIndex = process.argv.indexOf("--migrations-dir");
if (migrationsDirectoryIndex >= 0 && !process.argv[migrationsDirectoryIndex + 1]) throw new Error("--migrations-dir requires a directory");
const migrationsDirectory = migrationsDirectoryIndex >= 0 ? path.resolve(process.argv[migrationsDirectoryIndex + 1]) : path.resolve(scriptDirectory, "../../../infra/postgres/migrations");
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
  const outOfOrder = findOutOfOrderMigrations(applied, migrations);
  if (outOfOrder.length) throw new Error(`out-of-order migrations not recorded in schema_migrations: ${outOfOrder.map((migration) => migration.name).join(", ")}`);

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await client.query("begin");
    try {
      // Transaction-local, so the next migration and the session after the Migrator are unaffected.
      await client.query("select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [`${timeouts.lockTimeoutMs}ms`, `${timeouts.statementTimeoutMs}ms`]);
      await client.query(migration.sql);
      await client.query("insert into schema_migrations(name, checksum) values ($1, $2)", [migration.name, migration.checksum]);
      await client.query("commit");
      console.log(`Applied ${migration.name} (${migration.checksum})`);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw migrationFailure(migration.name, error);
    }
  }
  await enforceMigrationLedgerIntegrity(client);
} finally {
  if (lockAcquired) await client.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]).catch(() => undefined);
  await client.end();
}
