// D4 end to end on a scratch database: the Migrator runs as a dedicated migration owner (LOGIN, BYPASSRLS, no
// SUPERUSER, owner of the database), the owner runs the three principal scripts, and the control-plane account
// owns nothing yet has the DML it needs. DATABASE_URL must be a superuser connection; the test creates and drops
// its own database and roles (names carry the process id, so parallel runs do not collide).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { substitutePsqlIdentifierVariable } from "./lib/sql-lexer.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL (a superuser connection) is required");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${process.pid}`;
const database = `shz_owner_model_${suffix}`;
const owner = `shz_migration_owner_${suffix}`;
const controlPlane = `shz_control_plane_${suffix}`;
const servicePrincipals = ["shuzhiren_runtime_worker", "shuzhiren_channel_adapter", "shuzhiren_alert_notifier"];
const password = randomBytes(18).toString("hex");
const urlFor = (user, secret, name) => { const url = new URL(databaseUrl); url.username = user; url.password = secret; url.pathname = `/${name}`; return url.toString(); };
const superUrl = (() => { const url = new URL(databaseUrl); url.pathname = `/${database}`; return url.toString(); })();
const admin = new pg.Client({ connectionString: databaseUrl });
const createdServiceRoles = [];
let createdBackupRole = false;

function run(script, args, env) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

await admin.connect();
try {
  const superuser = (await admin.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]?.rolsuper;
  assert.equal(superuser, true, "DATABASE_URL must connect as a superuser to create the scratch database and roles");
  await admin.query(`create role "${owner}" login noinherit bypassrls nosuperuser nocreatedb nocreaterole noreplication password '${password}'`);
  await admin.query(`create role "${controlPlane}" nologin noinherit`);
  for (const role of servicePrincipals) {
    if ((await admin.query("select 1 from pg_roles where rolname = $1", [role])).rowCount === 0) { await admin.query(`create role ${role} nologin noinherit`); createdServiceRoles.push(role); }
  }
  if ((await admin.query("select 1 from pg_roles where rolname = 'shuzhiren_backup'")).rowCount === 0) { await admin.query("create role shuzhiren_backup login noinherit bypassrls"); createdBackupRole = true; }
  // The DBA creates the database with the migration owner as its owner (Runbook D4).
  await admin.query(`create database "${database}" owner "${owner}"`);

  // MIGRATION_OWNER_DATABASE_URL takes precedence over DATABASE_URL, which here points at a database that does
  // not exist, so a fallback would fail.
  const ownerUrl = urlFor(owner, password, database);
  const migrated = run("apps/console/scripts/migrate.mjs", [], { MIGRATION_OWNER_DATABASE_URL: ownerUrl, DATABASE_URL: urlFor(owner, password, `${database}_missing`) });
  assert.equal(migrated.status, 0, `the Migrator must run as the BYPASSRLS migration owner:\n${migrated.output}`);
  const rerun = run("apps/console/scripts/migrate.mjs", [], { MIGRATION_OWNER_DATABASE_URL: ownerUrl, DATABASE_URL: "" });
  assert.equal(rerun.status, 0, rerun.output);
  assert.doesNotMatch(rerun.output, /Applied /, "a second run applies nothing");

  const ownerClient = new pg.Client({ connectionString: ownerUrl });
  await ownerClient.connect();
  try {
    // The owner runs the principal scripts in one transaction each, as psql --single-transaction does.
    const scripts = [
      await readFile(path.join(root, "infra", "postgres", "service-principals.sql"), "utf8"),
      await readFile(path.join(root, "infra", "postgres", "backup-principal.sql"), "utf8"),
      substitutePsqlIdentifierVariable(await readFile(path.join(root, "infra", "postgres", "control-plane-principal.sql"), "utf8"), "control_plane_role", controlPlane)
    ];
    for (const script of scripts) {
      await ownerClient.query("begin");
      try { await ownerClient.query(script); await ownerClient.query("commit"); } catch (error) { await ownerClient.query("rollback"); throw error; }
    }
  } finally {
    await ownerClient.end();
  }

  const scratch = new pg.Client({ connectionString: superUrl });
  await scratch.connect();
  try {
    const owners = await scratch.query(`select r.rolname as owner, count(*)::int as objects from (
        select c.relowner as owner_oid, c.oid, 'pg_class'::regclass as catalog from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
        union all select p.proowner, p.oid, 'pg_proc'::regclass from pg_proc p where p.pronamespace = 'public'::regnamespace
        union all select t.typowner, t.oid, 'pg_type'::regclass from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
      ) object join pg_roles r on r.oid = object.owner_oid
      where not exists (select 1 from pg_depend d where d.classid = object.catalog and d.objid = object.oid and d.deptype = 'e')
      group by r.rolname order by r.rolname`);
    assert.equal(owners.rows.length, 1, `exactly one role must own the migration objects: ${JSON.stringify(owners.rows)}`);
    assert.equal(owners.rows[0].owner, owner, "the migration owner must own every migration object");
    const ledger = await scratch.query("select count(*)::int as count from schema_migrations");
    assert.ok(ledger.rows[0].count > 0);
  } finally {
    await scratch.end();
  }

  // db:verify checks the control-plane account that exists in this database.
  const verified = run("scripts/verify-postgres-schema.mjs", ["--allow-privileged", "--control-plane-role", controlPlane], { DATABASE_URL: superUrl });
  assert.equal(verified.status, 0, `db:verify must accept the D4 layout:\n${verified.output}`);
  // ... and rejects a control-plane account that owns a table.
  const scratchOwner = new pg.Client({ connectionString: superUrl });
  await scratchOwner.connect();
  await scratchOwner.query(`alter table channel_connections owner to "${controlPlane}"`);
  const rejected = run("scripts/verify-postgres-schema.mjs", ["--allow-privileged", "--control-plane-role", controlPlane], { DATABASE_URL: superUrl });
  await scratchOwner.query(`alter table channel_connections owner to "${owner}"`);
  await scratchOwner.end();
  assert.notEqual(rejected.status, 0, "db:verify must reject a control-plane account that owns a table");
  assert.match(rejected.output, /channel_connections/);
  console.log("PASS  migrations run as the BYPASSRLS migration owner, which owns every object and grants the control plane DML without ownership (D4)");
} finally {
  await admin.query(`drop database if exists "${database}" with (force)`).catch(() => undefined);
  await admin.query(`drop role if exists "${controlPlane}"`).catch(() => undefined);
  await admin.query(`drop role if exists "${owner}"`).catch(() => undefined);
  for (const role of createdServiceRoles) await admin.query(`drop role if exists ${role}`).catch(() => undefined);
  if (createdBackupRole) await admin.query("drop role if exists shuzhiren_backup").catch(() => undefined);
  await admin.end();
}
