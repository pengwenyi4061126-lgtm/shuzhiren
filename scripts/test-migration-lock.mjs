import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to test migration locking");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrator = path.join(root, "apps", "console", "scripts", "migrate.mjs");
const migrationLockName = "shuzhiren-schema-migrations";
const migrationsDirectory = path.join(root, "infra", "postgres", "migrations");
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

// L15: the Migrator set no lock_timeout or statement_timeout, so a migration waiting behind an application lock
// queued every later query behind its own lock indefinitely; and it applied a file that sorts before the newest
// recorded migration without noticing that migrations had been skipped or added out of order.
const runMigrator = (url, { env = {}, args = [] } = {}) => spawnSync(process.execPath, [migrator, ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url, ...env }, encoding: "utf8" });

for (const [name, value] of [["MIGRATION_LOCK_TIMEOUT_MS", "0"], ["MIGRATION_LOCK_TIMEOUT_MS", "-1"], ["MIGRATION_STATEMENT_TIMEOUT_MS", "1.5"], ["MIGRATION_STATEMENT_TIMEOUT_MS", "abc"], ["MIGRATION_LOCK_TIMEOUT_MS", "86400001"]]) {
  // Port 1 refuses connections: the variable must be rejected before the Migrator tries to connect.
  const result = runMigrator("postgresql://migrator:unused@127.0.0.1:1/shuzhiren", { env: { [name]: value } });
  assert.notEqual(result.status, 0, `${name}=${value} must stop the Migrator`);
  assert.match(`${result.stderr}${result.stdout}`, new RegExp(`${name} must be an integer between 1 and 86400000`));
}

const scratchDatabase = `shuzhiren_migrator_test_${process.pid}`;
const scratchUrl = (() => { const url = new URL(databaseUrl); url.pathname = `/${scratchDatabase}`; return url.toString(); })();
const fixtureDirectories = [];
const admin = new pg.Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`create database "${scratchDatabase}"`);
const scratch = new pg.Client({ connectionString: scratchUrl });
try {
  const migrated = runMigrator(scratchUrl);
  assert.equal(migrated.status, 0, migrated.stderr);
  await scratch.connect();
  const ledger = async () => (await scratch.query("select name, checksum, applied_at from schema_migrations order by name")).rows;

  // A gap in the numbering (050) is not a missing migration; a recorded migration that is no longer recorded is.
  const outOfOrderName = "049_outbox_cancelled_state.sql";
  const removed = (await scratch.query("delete from schema_migrations where name = $1 returning name, checksum, applied_at", [outOfOrderName])).rows[0];
  assert.ok(removed, `test fixture requires ${outOfOrderName}`);
  const before = await ledger();
  const outOfOrder = runMigrator(scratchUrl);
  assert.notEqual(outOfOrder.status, 0, "an unrecorded migration that sorts before the newest recorded one must stop the Migrator");
  assert.match(outOfOrder.stderr, new RegExp(`out-of-order migrations not recorded in schema_migrations: ${outOfOrderName}`));
  assert.deepEqual(await ledger(), before, "a rejected out-of-order run must not change schema_migrations");
  await scratch.query("insert into schema_migrations (name, checksum, applied_at) values ($1, $2, $3)", [removed.name, removed.checksum, removed.applied_at]);
  const caughtUp = runMigrator(scratchUrl);
  assert.equal(caughtUp.status, 0, caughtUp.stderr);

  const withFixtures = async (fixtures) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "migrator-fixtures-"));
    fixtureDirectories.push(directory);
    for (const name of await readdir(migrationsDirectory)) if (name.endsWith(".sql")) await copyFile(path.join(migrationsDirectory, name), path.join(directory, name));
    for (const [name, sql] of Object.entries(fixtures)) await writeFile(path.join(directory, name), sql);
    return directory;
  };

  // lock_timeout: a pending migration that cannot get its lock fails, names the file and the timeout, records
  // nothing, stops before later files and releases the advisory lock.
  const lockDirectory = await withFixtures({ "9990_lock_probe.sql": "alter table products add column migrator_lock_probe text;\n", "9991_after_lock_probe.sql": "create table migrator_after_lock_probe (id integer);\n" });
  const holder = new pg.Client({ connectionString: scratchUrl });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query("lock table products in access exclusive mode");
    const started = Date.now();
    const blocked = runMigrator(scratchUrl, { env: { MIGRATION_LOCK_TIMEOUT_MS: "1500" }, args: ["--migrations-dir", lockDirectory] });
    const elapsed = Date.now() - started;
    assert.notEqual(blocked.status, 0, "a migration that cannot get its lock must fail");
    assert.match(blocked.stderr, /migration 9990_lock_probe\.sql failed: .*\(lock_timeout\)/);
    assert.ok(elapsed < 1_500 + 5_000, `the Migrator must give up after lock_timeout, but took ${elapsed} ms`);
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end();
  }
  assert.deepEqual((await scratch.query("select name from schema_migrations where name like '999%'")).rows, [], "a timed-out migration and the files after it must not be recorded");
  assert.equal((await scratch.query("select to_regclass('migrator_after_lock_probe') as table")).rows[0].table, null);
  const unlock = await scratch.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [migrationLockName]);
  assert.equal(unlock.rows[0].acquired, true, "a failed migration must release the migration advisory lock");
  await scratch.query("select pg_advisory_unlock(hashtext($1))", [migrationLockName]);

  // The configured values apply inside each migration transaction, a file's SET LOCAL overrides them for that
  // file only, and they do not outlive the Migrator.
  const probeDirectory = await withFixtures({
    "9995_probe_timeouts.sql": "create table migrator_probe_timeouts as select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout;\n",
    "9996_probe_override.sql": "set local lock_timeout = '1234ms';\ncreate table migrator_probe_override as select current_setting('lock_timeout') as lock_timeout;\n",
    "9997_probe_after.sql": "create table migrator_probe_after as select current_setting('lock_timeout') as lock_timeout;\n"
  });
  const probed = runMigrator(scratchUrl, { env: { MIGRATION_LOCK_TIMEOUT_MS: "4321", MIGRATION_STATEMENT_TIMEOUT_MS: "654321" }, args: ["--migrations-dir", probeDirectory] });
  assert.equal(probed.status, 0, probed.stderr);
  assert.deepEqual((await scratch.query("select lock_timeout, statement_timeout from migrator_probe_timeouts")).rows, [{ lock_timeout: "4321ms", statement_timeout: "654321ms" }]);
  assert.deepEqual((await scratch.query("select lock_timeout from migrator_probe_override")).rows, [{ lock_timeout: "1234ms" }]);
  assert.deepEqual((await scratch.query("select lock_timeout from migrator_probe_after")).rows, [{ lock_timeout: "4321ms" }]);
  assert.equal((await scratch.query("show lock_timeout")).rows[0].lock_timeout, "0");
  console.log("PASS  the Migrator bounds lock and statement waits, names the failed file and rejects out-of-order migrations (L15)");
} finally {
  await scratch.end().catch(() => undefined);
  await admin.query(`drop database if exists "${scratchDatabase}" with (force)`).catch(() => undefined);
  await admin.end();
  for (const directory of fixtureDirectories) await rm(directory, { recursive: true, force: true });
}
