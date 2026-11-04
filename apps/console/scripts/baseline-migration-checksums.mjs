import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertKnownMigrationLedger, ensureMigrationLedger, enforceMigrationLedgerIntegrity, loadMigrations, migrationLockName } from "./migration-integrity.mjs";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
const approved = process.argv.includes("--approve-current-files");
if (!databaseUrl) throw new Error("DATABASE_URL is required to baseline migration checksums");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrations = await loadMigrations(path.resolve(scriptDirectory, "../../../infra/postgres/migrations"));
const client = new Client({ connectionString: databaseUrl });
let lockAcquired = false;

await client.connect();
try {
  const lock = await client.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [migrationLockName]);
  if (lock.rows[0]?.acquired !== true) throw new Error("another schema migration is already running");
  lockAcquired = true;
  await ensureMigrationLedger(client);
  const appliedRows = (await client.query("select name, checksum from schema_migrations order by name")).rows;
  const unknown = appliedRows.filter((row) => !migrations.some((migration) => migration.name === row.name));
  if (unknown.length) throw new Error(`database records migration files missing from this checkout: ${unknown.map((row) => row.name).join(", ")}`);
  const drifted = appliedRows.filter((row) => row.checksum && migrations.find((migration) => migration.name === row.name)?.checksum !== row.checksum);
  if (drifted.length) throw new Error(`migration checksum drift detected; refusing baseline: ${drifted.map((row) => row.name).join(", ")}`);
  const legacy = appliedRows.filter((row) => !row.checksum);
  if (!legacy.length) {
    assertKnownMigrationLedger(appliedRows, migrations);
    await enforceMigrationLedgerIntegrity(client);
    console.log("PASS migration checksum ledger is already complete");
  } else if (!approved) {
    console.error(`ERROR ${legacy.length} applied migration(s) have no checksum. Review the file list and rerun with --approve-current-files as the migration schema owner:`);
    for (const row of legacy) console.error(`  ${row.name}`);
    process.exitCode = 2;
  } else {
    await client.query("begin");
    try {
      for (const row of legacy) {
        const migration = migrations.find((candidate) => candidate.name === row.name);
        await client.query("update schema_migrations set checksum = $2 where name = $1 and checksum is null", [row.name, migration.checksum]);
      }
      await enforceMigrationLedgerIntegrity(client);
      await client.query("commit");
      console.log(`PASS baselined ${legacy.length} reviewed migration checksum(s)`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  if (lockAcquired) await client.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]).catch(() => undefined);
  await client.end();
}
