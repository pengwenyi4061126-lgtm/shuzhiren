import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to test migration integrity");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrator = path.join(root, "apps", "console", "scripts", "migrate.mjs");
const baseliner = path.join(root, "apps", "console", "scripts", "baseline-migration-checksums.mjs");
const client = new pg.Client({ connectionString: databaseUrl });
let selected;

await client.connect();
try {
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
