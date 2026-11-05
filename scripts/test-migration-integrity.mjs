import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertKnownMigrationLedger, findUnguardedDataFixStatements, firstGuardedDataFixMigration, loadMigrations, migrationChecksum } from "../apps/console/scripts/migration-integrity.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to test migration integrity");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrator = path.join(root, "apps", "console", "scripts", "migrate.mjs");
const baseliner = path.join(root, "apps", "console", "scripts", "baseline-migration-checksums.mjs");
const migrationsDirectory = path.join(root, "infra", "postgres", "migrations");
const client = new pg.Client({ connectionString: databaseUrl });
let selected;

await client.connect();
try {
  await assertLineEndingIndependentChecksums();
  await assertSchemaVerifierRlsCoverage();
  await assertDataFixGuard();
  selected = (await client.query("select name, checksum from schema_migrations order by name limit 1")).rows[0];
  assert.ok(selected?.name && selected?.checksum, "test fixture requires a checksum-protected applied migration");
  await client.query("update schema_migrations set checksum = repeat('0', 64) where name = $1", [selected.name]);
  const drift = spawnSync(process.execPath, [migrator], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
  assert.notEqual(drift.status, 0, "a changed applied checksum must stop migrations");
  assert.match(`${drift.stderr}${drift.stdout}`, /migration checksum drift detected/);

  await client.query("alter table schema_migrations alter column checksum drop not null");
  await client.query("update schema_migrations set checksum = null where name = $1", [selected.name]);
  const unapproved = spawnSync(process.execPath, [baseliner], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
  assert.notEqual(unapproved.status, 0, "legacy checksum rows must require explicit baseline approval");
  assert.match(`${unapproved.stderr}${unapproved.stdout}`, /--approve-current-files/);
  const approved = spawnSync(process.execPath, [baseliner, "--approve-current-files"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
  assert.equal(approved.status, 0, approved.stderr);
  const restored = await client.query("select checksum from schema_migrations where name = $1", [selected.name]);
  assert.equal(restored.rows[0]?.checksum, selected.checksum, "approved baseline must restore the reviewed current migration checksum");
  console.log("PASS migration ledger rejects drift and requires explicit checksum baselining for legacy rows");
} finally {
  if (selected) {
    await client.query("alter table schema_migrations alter column checksum drop not null").catch(() => undefined);
    await client.query("update schema_migrations set checksum = $2 where name = $1", [selected.name, selected.checksum]).catch(() => undefined);
    await client.query("alter table schema_migrations alter column checksum set not null").catch(() => undefined);
  }
  await client.end().catch(() => undefined);
}

// M4: checksums were the SHA-256 of the file text as read, so a Windows checkout with core.autocrlf=true (CRLF
// files) no longer matched the checksums recorded from LF checkouts and the Migrator refused to run.
async function assertLineEndingIndependentChecksums() {
  const appliedRows = (await client.query("select name, checksum from schema_migrations order by name")).rows;
  const lf = await loadMigrations(migrationsDirectory);
  assert.ok(lf.length > 0 && appliedRows.length === lf.length, "test fixture requires every migration file to be applied");
  const crlfDirectory = await mkdtemp(path.join(os.tmpdir(), "migrations-crlf-"));
  try {
    for (const name of await readdir(migrationsDirectory)) {
      if (!name.endsWith(".sql")) continue;
      const raw = await readFile(path.join(migrationsDirectory, name));
      assert.equal(raw.includes(0x0d), false, `${name} must be checked out with LF line endings`);
      const crlf = Buffer.from(raw.toString("latin1").replaceAll("\n", "\r\n"), "latin1");
      const rawSha256 = createHash("sha256").update(raw).digest("hex");
      assert.equal(migrationChecksum(raw), rawSha256, `${name}: an LF file must keep the SHA-256 of its bytes as checksum`);
      assert.equal(migrationChecksum(crlf), rawSha256, `${name}: CRLF line endings must not change the checksum`);
      for (const [variant, bytes] of [["trailing space", Buffer.concat([raw, Buffer.from(" ")])], ["lone CR", Buffer.concat([raw, Buffer.from("\r")])], ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw])]]) {
        assert.notEqual(migrationChecksum(bytes), rawSha256, `${name}: a ${variant} is a content change and must change the checksum`);
      }
      await writeFile(path.join(crlfDirectory, name), crlf);
    }
    const crlfMigrations = await loadMigrations(crlfDirectory);
    assert.deepEqual(crlfMigrations.map(({ name, checksum }) => ({ name, checksum })), lf.map(({ name, checksum }) => ({ name, checksum })));
    assert.deepEqual(crlfMigrations.map((migration) => migration.sql), lf.map((migration) => migration.sql), "a CRLF checkout must execute the same SQL as an LF checkout");
    assert.doesNotThrow(() => assertKnownMigrationLedger(appliedRows, crlfMigrations), "checksums recorded from an LF checkout must match a CRLF checkout");
    const drifted = crlfMigrations.map((migration, index) => (index === 0 ? { ...migration, checksum: migrationChecksum(`${migration.sql} `) } : migration));
    assert.throws(() => assertKnownMigrationLedger(appliedRows, drifted), /migration checksum drift detected/);
  } finally {
    await rm(crlfDirectory, { recursive: true, force: true });
  }

  // .gitattributes keeps migrations and shell scripts LF on every checkout, so the bytes above are what CI,
  // production images and Windows clones all see.
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "infra/postgres/migrations/*.sql", "*.sh"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.some((file) => file.endsWith(".sql")) && tracked.some((file) => file.endsWith(".sh")), "git must list the tracked migrations and shell scripts");
  const attributes = execFileSync("git", ["check-attr", "-z", "eol", "--", ...tracked], { cwd: root, encoding: "utf8" }).split("\0");
  const notLf = [];
  for (let index = 0; index + 2 < attributes.length; index += 3) if (attributes[index + 2] !== "lf") notLf.push(attributes[index]);
  assert.deepEqual(notLf, [], "every tracked migration and shell script must have the eol=lf attribute");
  console.log("PASS migration checksums are independent of CRLF checkouts and still match the recorded ledger (M4)");
}

// M5: the Schema_Verifier's RLS list was built with Set.add(a, b, c), which adds only the first argument, so
// settlement_lines and settlement_reconciliation_exceptions were never checked, and tables missing from the
// hand-written list were never checked at all. RLS coverage now comes from the catalog.
async function assertSchemaVerifierRlsCoverage() {
  const verifier = path.join(root, "scripts", "verify-postgres-schema.mjs");
  const verify = () => spawnSync(process.execPath, [verifier, "--allow-privileged"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
  const baseline = verify();
  assert.equal(baseline.status, 0, `the Schema_Verifier must pass on the migrated database: ${baseline.stderr}`);
  for (const table of ["settlement_lines", "settlement_reconciliation_exceptions"]) {
    await client.query(`alter table ${table} no force row level security`);
    try {
      const result = verify();
      assert.notEqual(result.status, 0, `the Schema_Verifier must fail when ${table} does not force RLS`);
      assert.match(result.stderr, new RegExp(`table=${table} missing=FORCE`));
    } finally {
      await client.query(`alter table ${table} force row level security`);
    }
  }
  const probe = `rls_probe_${process.pid}`;
  await client.query(`create table ${probe} (id uuid primary key, tenant_id uuid not null)`);
  try {
    const result = verify();
    assert.notEqual(result.status, 0, "the Schema_Verifier must fail for a tenant table without RLS that no list mentions");
    assert.match(result.stderr, new RegExp(`table=${probe} missing=ENABLE,FORCE`));
  } finally {
    await client.query(`drop table if exists ${probe}`);
  }
  const restored = verify();
  assert.equal(restored.status, 0, `the Schema_Verifier must pass again after RLS is restored: ${restored.stderr}`);
  console.log("PASS Schema_Verifier reports every tenant table without ENABLE and FORCE row level security (M5)");
}

// M12: a data-fix statement in a migration is filtered by FORCE ROW LEVEL SECURITY when the migration role owns
// the table without BYPASSRLS and sets no app.tenant_id, so it silently changes 0 rows (048, 061). From 079 on,
// data fixes go through migration_fix_*, which compares the affected rows with an unfiltered count, and the
// Migrator refuses a pending migration >= 079 that changes rows without them.
async function assertDataFixGuard() {
  await assertDataFixTextGuard();
  const owner = `it_datafix_owner_${process.pid}`;
  const bypass = `it_datafix_bypass_${process.pid}`;
  const tenants = [randomUuid(), randomUuid()];
  const directories = [];
  await client.query(`create role ${owner} nologin nobypassrls`);
  await client.query(`create role ${bypass} nologin bypassrls`);
  try {
    await client.query("insert into tenants (id, slug, name) values ($1, $3, 'Data-fix guard A'), ($2, $4, 'Data-fix guard B')", [...tenants, `datafix-a-${tenants[0]}`, `datafix-b-${tenants[1]}`]);
    await client.query("create schema it_datafix");
    await client.query(`grant usage on schema it_datafix to ${owner}, ${bypass}`);
    await client.query(`grant select on tenants to ${owner}, ${bypass}`);
    for (const signature of ["migration_unfiltered_count(regclass[], text)", "migration_assert_row_count(regclass, bigint, bigint)", "migration_fix_update(regclass, text, text, text, text, regclass[], boolean)"]) await client.query(`grant execute on function ${signature} to ${owner}, ${bypass}`);
    await assertReplayedHistoricalFixesAreFiltered(owner, tenants);
    await client.query("create table it_datafix.target (id serial primary key, tenant_id uuid not null, fixed boolean not null default false)");
    await client.query("alter table it_datafix.target enable row level security");
    await client.query("alter table it_datafix.target force row level security");
    await client.query("create policy tenant_isolation on it_datafix.target using (tenant_id::text = current_setting('app.tenant_id', true))");
    const resetRows = async (tableOwner) => {
      await client.query(`alter table it_datafix.target owner to ${tableOwner}`);
      await client.query("delete from it_datafix.target");
      await client.query("insert into it_datafix.target (tenant_id) values ($1), ($1), ($2), ($2)", tenants);
    };
    const runFixture = async (name, sql) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "migrations-datafix-"));
      directories.push(directory);
      for (const file of await readdir(migrationsDirectory)) if (file.endsWith(".sql")) await writeFile(path.join(directory, file), await readFile(path.join(migrationsDirectory, file)));
      await writeFile(path.join(directory, name), sql);
      const result = spawnSync(process.execPath, [migrator, "--migrations-dir", directory], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
      const recorded = (await client.query("select checksum from schema_migrations where name = $1", [name])).rows[0]?.checksum;
      const fixed = (await client.query("select tenant_id, fixed from it_datafix.target order by id")).rows.filter((row) => row.fixed).length;
      await client.query("delete from schema_migrations where name = $1", [name]);
      return { status: result.status, output: `${result.stderr}${result.stdout}`, recorded, fixed, checksum: migrationChecksum(sql) };
    };
    const fix = (perTenant) => `select migration_fix_update('it_datafix.target', 'target', $set$ fixed = true $set$, $where$ not target.fixed $where$${perTenant ? ", p_per_tenant => true" : ""});\n`;

    // The Migrator refuses an unguarded data fix before it applies any pending file.
    const unguarded = await runFixture("9001_test_datafix_unguarded.sql", "-- fixture\nselect 1;\nupdate it_datafix.target set fixed = true;\n");
    assert.notEqual(unguarded.status, 0, "the Migrator must refuse an unguarded data-fix statement in a migration numbered >= 079");
    assert.match(unguarded.output, /unguarded data-fix statements[^\n]*9001_test_datafix_unguarded\.sql:3/, "the refusal must name the file and line");
    assert.equal(unguarded.recorded, undefined);

    // 9a: owner without BYPASSRLS and no app.tenant_id; 9b: app.tenant_id set to one tenant only.
    await resetRows(owner);
    for (const [label, setup, affected] of [["9002_test_datafix_no_tenant.sql", "", 0], ["9003_test_datafix_one_tenant.sql", `select set_config('app.tenant_id', '${tenants[0]}', true);\n`, 2]]) {
      const result = await runFixture(label, `set local role ${owner};\n${setup}${fix(false)}reset role;\n`);
      assert.notEqual(result.status, 0, `${label}: a data fix hidden by RLS must fail the migration`);
      assert.match(result.output, new RegExp(`migration ${label.replaceAll(".", "\\.")} failed: data-fix row count mismatch on it_datafix\\.target: expected 4 rows, affected ${affected}`));
      assert.equal(result.recorded, undefined, `${label}: a failed data fix must not be recorded in schema_migrations`);
      assert.equal(result.fixed, 0, `${label}: a failed data fix must roll back`);
    }
    // 10a: owner with BYPASSRLS, no tenant; 10b: owner without BYPASSRLS using p_per_tenant.
    for (const [label, role, perTenant] of [["9004_test_datafix_bypass.sql", bypass, false], ["9005_test_datafix_per_tenant.sql", owner, true]]) {
      await resetRows(role);
      const result = await runFixture(label, `set local role ${role};\n${fix(perTenant)}reset role;\n`);
      assert.equal(result.status, 0, `${label}: ${result.output}`);
      assert.equal(result.recorded, result.checksum, `${label}: the migration must be recorded with its checksum`);
      assert.equal(result.fixed, 4, `${label}: every target row of both tenants must be fixed`);
    }
    console.log("PASS data fixes in migrations >= 079 go through migration_fix_* and fail instead of changing 0 rows under RLS (M12)");
  } finally {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    await client.query("drop schema if exists it_datafix cascade").catch(() => undefined);
    await client.query("drop schema if exists it_replay cascade").catch(() => undefined);
    await client.query("delete from tenants where id = any($1::uuid[])", [tenants]).catch(() => undefined);
    for (const role of [owner, bypass]) {
      await client.query(`drop owned by ${role}`).catch(() => undefined);
      await client.query(`drop role if exists ${role}`).catch(() => undefined);
    }
  }
}

async function assertDataFixTextGuard() {
  const flagged = [
    "update t set a = 1;",
    "delete from t where a = 1;",
    "merge into t using s on t.id = s.id when matched then delete;",
    "insert into t (a) select a from s;",
    "with stale as (select id from t) update t set a = 1 from stale where t.id = stale.id;",
    "do $$ begin update t set a = 1; end $$;",
    "do $body$ declare n int; begin if true then delete from t; end if; end $body$;",
    "do $$ begin for r in select 1 loop insert into t (a) select 1; end loop; end $$;"
  ];
  for (const sql of flagged) assert.equal(findUnguardedDataFixStatements(sql).length, 1, `must be reported: ${sql}`);
  const allowed = [
    "select migration_fix_update('t', 't', $set$ a = 1 $set$, $where$ t.a = 0 $where$);",
    "create or replace function f() returns void language plpgsql as $$ begin update t set a = 1; delete from t; end $$;",
    "create procedure p() language sql as $$ update t set a = 1 $$;",
    "insert into t (a) values (1) on conflict (a) do update set a = excluded.a;",
    "-- update t set a = 1;\n/* delete from t; */ select 'update t set a = 1';",
    "do $$ begin perform 1 from t for update; insert into t (a) values (1) on conflict do nothing; end $$;",
    "alter table t add column b int; create index t_b on t (b);"
  ];
  for (const sql of allowed) assert.deepEqual(findUnguardedDataFixStatements(sql), [], `must not be reported: ${sql}`);
  assert.deepEqual(findUnguardedDataFixStatements("select 1;\n\n  update t\n  set a = 1;").map((violation) => violation.line), [3]);
  return loadMigrations(migrationsDirectory).then((migrations) => {
    const guarded = migrations.filter((migration) => Number.parseInt(migration.name, 10) >= firstGuardedDataFixMigration);
    assert.ok(guarded.some((migration) => migration.name.startsWith("079_")), "079 must be guarded");
    for (const migration of guarded) assert.deepEqual(findUnguardedDataFixStatements(migration.sql), [], `${migration.name} must not contain unguarded data-fix statements`);
  });
}

// Replays the UPDATE statements of 048 and 061, as written in the files, as a table owner without BYPASSRLS and
// without app.tenant_id, on copies of the tables with the same FORCE RLS policy, and prints the row counts.
async function assertReplayedHistoricalFixesAreFiltered(owner, tenants) {
  const statementOf = async (file) => {
    const sql = (await readFile(path.join(migrationsDirectory, file), "utf8")).replaceAll("\r\n", "\n");
    const found = findUnguardedDataFixStatements(sql);
    assert.equal(found.length, 1, `${file} must contain exactly one data-fix statement`);
    return found[0].statement;
  };
  await client.query("create schema it_replay");
  await client.query(`grant usage on schema it_replay to ${owner}`);
  for (const table of ["runtime_alerts", "channel_connections", "memberships"]) {
    await client.query(`create table it_replay.${table} as select * from public.${table} with no data`);
    await client.query(`alter table it_replay.${table} owner to ${owner}`);
    await client.query(`alter table it_replay.${table} enable row level security`);
    await client.query(`alter table it_replay.${table} force row level security`);
    await client.query(`create policy tenant_isolation on it_replay.${table} using (tenant_id::text = current_setting('app.tenant_id', true))`);
  }
  const runId = randomUuid();
  for (const tenant of tenants) {
    await client.query("insert into it_replay.runtime_alerts (id, tenant_id, live_run_id, severity, code, message, status, opened_at) values ($1, $3, $4, 'warning', 'it_duplicate', 'duplicate', 'open', now() - interval '1 minute'), ($2, $3, $4, 'warning', 'it_duplicate', 'duplicate', 'open', now())", [randomUuid(), randomUuid(), tenant, runId]);
    await client.query("insert into it_replay.channel_connections (id, tenant_id, status) values ($1, $2, 'connected')", [randomUuid(), tenant]);
  }
  for (const [file, label] of [["048_runtime_alert_open_uniqueness.sql", "048"], ["061_channel_verification_remediation.sql", "061"]]) {
    const statement = await statementOf(file);
    const replay = async (role) => {
      await client.query("begin");
      try {
        await client.query("set local search_path = it_replay, public");
        if (role) await client.query(`set local role ${role}`);
        return (await client.query(statement)).rowCount;
      } finally {
        await client.query("rollback");
      }
    };
    const unfiltered = await replay(null);
    const filtered = await replay(owner);
    console.log(`EVIDENCE M12 ${label}: UPDATE from ${file} replayed as table owner without BYPASSRLS and without app.tenant_id: rowCount=${filtered}; unfiltered rowCount=${unfiltered}`);
    assert.equal(unfiltered, 2, `${label}: the replay fixture must have two target rows`);
    assert.equal(filtered, 0, `${label}: under FORCE RLS the replayed UPDATE changes no rows`);
  }
}

function randomUuid() { return globalThis.crypto.randomUUID(); }
