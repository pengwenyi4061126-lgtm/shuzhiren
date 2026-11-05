import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertKnownMigrationLedger, loadMigrations, migrationChecksum } from "../apps/console/scripts/migration-integrity.mjs";

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
