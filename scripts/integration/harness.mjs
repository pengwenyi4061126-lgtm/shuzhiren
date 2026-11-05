// Shared real-PostgreSQL test harness (design part 8, sections 1.1-1.5). Each test file calls
// createHarness(import.meta.url) in before() and h.close() in after(); the harness clones the run's template
// into a database of its own. Run through scripts/run-postgres-integration.mjs (npm run postgres:integration),
// or directly with `node --test scripts/integration/<file>.test.mjs` and DATABASE_URL set, in which case the
// harness prepares the cluster in-process. There is no skip path: a missing prerequisite throws
// HarnessPrerequisiteError, which fails the file's before hook.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  cleanupRun, DATABASE_PREFIX, databaseNameFor, deriveUrl, isRunId, PRINCIPALS, prepareCluster, quoteIdent, redact,
  REPO_ROOT, roleSpec, runMigrator, SERVICE_PRINCIPALS, temporaryRoleName
} from "./lib/cluster.mjs";
import { startHttpStub } from "./lib/http-stub.mjs";
import { createOidcStub } from "./lib/oidc.mjs";
import { createSeed } from "./lib/seed.mjs";

export { PRINCIPALS, SERVICE_PRINCIPALS } from "./lib/cluster.mjs";
export { runTriggerCase } from "./lib/trigger-coverage.mjs";

export class HarnessPrerequisiteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "HarnessPrerequisiteError";
  }
}

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "infra", "postgres", "migrations");

/** The session identity query of section 1.3 (Requirement 36.6). */
export const SESSION_IDENTITY_SQL = `select session_user::text as session_user, r.rolsuper, r.rolbypassrls,
       (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships
from pg_roles r where r.rolname = session_user`;

/** Asserts a session_identity row: expected user, not superuser, no BYPASSRLS, no memberships. */
export function checkSessionIdentity(row, expectedRole) {
  assert.ok(row, `session identity of ${expectedRole} could not be read`);
  assert.equal(row.session_user, expectedRole, `session_user must be ${expectedRole}`);
  assert.equal(row.rolsuper, false, `${expectedRole} must not be a superuser`);
  assert.equal(row.rolbypassrls, false, `${expectedRole} must not have BYPASSRLS`);
  assert.equal(row.memberships, 0, `${expectedRole} must not be a member of any role`);
}

let runPromise = null;
let openHarnesses = 0;

function runFromEnvironment() {
  const runId = process.env.SHZ_IT_RUN_ID;
  if (!runId) return null;
  if (!isRunId(runId) || !process.env.SHZ_IT_TEMPLATE || !process.env.SHZ_IT_ROLE_SECRETS) throw new HarnessPrerequisiteError("SHZ_IT_RUN_ID is set but SHZ_IT_TEMPLATE or SHZ_IT_ROLE_SECRETS is missing or invalid; run through npm run postgres:integration");
  let secrets;
  try {
    secrets = JSON.parse(process.env.SHZ_IT_ROLE_SECRETS);
  } catch {
    throw new HarnessPrerequisiteError("SHZ_IT_ROLE_SECRETS is not valid JSON");
  }
  const skipped = process.env.SHZ_IT_SKIPPED_GRANT_SCRIPTS ? JSON.parse(process.env.SHZ_IT_SKIPPED_GRANT_SCRIPTS) : [];
  return { runId, template: process.env.SHZ_IT_TEMPLATE, secrets, skippedGrantScripts: skipped, ownsRun: false };
}

async function currentRun(databaseUrl) {
  runPromise ??= (async () => {
    const fromEnv = runFromEnvironment();
    if (fromEnv) return fromEnv;
    try {
      const prepared = await prepareCluster({ databaseUrl });
      return { ...prepared, ownsRun: true };
    } catch (error) {
      throw new HarnessPrerequisiteError(`cluster preparation failed: ${error.message}`, { cause: error });
    }
  })();
  try {
    return await runPromise;
  } catch (error) {
    runPromise = null;
    throw error;
  }
}

/**
 * @param {string} testFileUrl import.meta.url of the test file.
 * @param {{ database?: "clone" | "none" }} [options]
 */
export async function createHarness(testFileUrl, { database = "clone" } = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new HarnessPrerequisiteError("DATABASE_URL is not set; the integration harness needs a PostgreSQL superuser connection string");
  if (database !== "clone" && database !== "none") throw new HarnessPrerequisiteError(`createHarness database must be "clone" or "none", found ${JSON.stringify(database)}`);
  const run = await currentRun(databaseUrl);
  openHarnesses += 1;
  const testFile = testFileUrl.startsWith("file:") ? fileURLToPath(testFileUrl) : testFileUrl;
  const keep = process.env.SHZ_IT_KEEP === "true";
  const secretValues = [...Object.values(run.secrets), decodeURIComponent(new URL(databaseUrl).password)];
  const clean = (text) => redact(text, secretValues);
  let counter = 0;
  const next = () => `${process.pid.toString(36)}${(counter += 1).toString(36)}`;

  const clients = new Set();
  const pools = new Set();
  const stubs = new Set();
  const databases = [];
  const roles = [];
  const tempDirs = [];
  const maintenance = new pg.Client({ connectionString: databaseUrl, application_name: "shz-it-maintenance" });
  await maintenance.connect();

  let databaseName = null;
  if (database === "clone") {
    databaseName = databaseNameFor(run.runId, testFile, next());
    await maintenance.query(`create database ${quoteIdent(databaseName)} template ${quoteIdent(run.template)} owner ${quoteIdent(PRINCIPALS.migration_owner)}`);
    databases.push(databaseName);
  }

  const resolveRole = (principal, password) => {
    if (principal === "superuser") return { user: undefined, password: undefined };
    if (Object.hasOwn(PRINCIPALS, principal)) return { user: PRINCIPALS[principal], password: run.secrets[PRINCIPALS[principal]] };
    if (password !== undefined) return { user: principal, password };
    throw new HarnessPrerequisiteError(`unknown principal ${JSON.stringify(principal)}`);
  };
  const expectedRole = (principal) => (Object.hasOwn(PRINCIPALS, principal) ? PRINCIPALS[principal] : principal);

  const url = (principal, { database: target, applicationName, password } = {}) => {
    const role = resolveRole(principal, password);
    const name = target ?? databaseName ?? undefined;
    return deriveUrl(databaseUrl, { user: role.user, password: role.password, database: name, applicationName });
  };

  const assertSessionIdentity = async (client, principal) => {
    const result = await client.query(SESSION_IDENTITY_SQL);
    checkSessionIdentity(result.rows[0], expectedRole(principal));
  };

  const connectAs = async (principal, { applicationName, database: target, password } = {}) => {
    const client = new pg.Client({ connectionString: url(principal, { database: target, applicationName, password }) });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw new Error(clean(`cannot connect as ${principal}: ${error.message}`), { cause: error });
    }
    clients.add(client);
    const originalEnd = client.end.bind(client);
    client.end = async () => { clients.delete(client); return originalEnd(); };
    if (SERVICE_PRINCIPALS.includes(principal)) await assertSessionIdentity(client, principal);
    return client;
  };

  const admin = database === "clone" ? await connectAs("superuser", { applicationName: "shz-it-admin" }) : maintenance;

  const transaction = async (client, fn) => {
    await client.query("begin");
    try {
      const value = await fn(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  };

  const stub = async () => {
    const created = await startHttpStub();
    stubs.add(created);
    return created;
  };
  const oidcStub = await stub();
  const oidc = createOidcStub(oidcStub);

  const harness = {
    runId: run.runId,
    template: run.template,
    skippedGrantScripts: run.skippedGrantScripts ?? [],
    principals: PRINCIPALS,
    databaseName,
    admin,
    url,
    connectAs,
    pool(principal, options = {}) {
      const created = new pg.Pool({ ...options, connectionString: url(principal, { applicationName: options.application_name }) });
      pools.add(created);
      return created;
    },
    assertSessionIdentity,
    withTenant(client, tenantId, fn) {
      return transaction(client, async (c) => {
        await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        return fn(c);
      });
    },
    /** Superuser transaction with session_replication_role = replica (foreign-key RI triggers are off too). */
    withReplicaRole(fn) {
      return transaction(admin, async (c) => {
        await c.query("set local session_replication_role = replica");
        return fn(c);
      });
    },
    /** One transaction with `alter table … disable trigger user`; foreign keys stay enforced. */
    withTriggersDisabled(table, fn) {
      const identifier = String(table).split(".").map(quoteIdent).join(".");
      return transaction(admin, async (c) => {
        await c.query(`alter table ${identifier} disable trigger user`);
        const value = await fn(c);
        await c.query(`alter table ${identifier} enable trigger user`);
        return value;
      });
    },
    async snapshot(sql, params = []) {
      return (await admin.query(sql, params)).rows;
    },
    seed: createSeed(admin),
    seedFor: (client) => createSeed(client),
    migrate({ as, database: target, migrationsDir, env = {}, timeoutMs } = {}) {
      if (!as) throw new HarnessPrerequisiteError("migrate requires { as }");
      return runMigrator({ databaseUrl: url(as, { database: target, applicationName: "shz-it-migrate" }), migrationsDir, env, timeoutMs, secrets: secretValues });
    },
    /** Temporary directory holding the first k migration files (by name), copied byte for byte. */
    async migrationsSubset(k) {
      const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
      if (!Number.isInteger(k) || k < 0 || k > names.length) throw new RangeError(`migrationsSubset(k) needs 0 <= k <= ${names.length}, found ${k}`);
      const directory = await mkdtemp(path.join(os.tmpdir(), "shz-it-migrations-"));
      tempDirs.push(directory);
      for (const name of names.slice(0, k)) await copyFile(path.join(MIGRATIONS_DIR, name), path.join(directory, name));
      return directory;
    },
    async createEmptyDatabase({ owner } = {}) {
      if (owner !== "migration_owner" && owner !== "owner_nobypass") throw new HarnessPrerequisiteError(`createEmptyDatabase owner must be migration_owner or owner_nobypass, found ${JSON.stringify(owner)}`);
      const name = databaseNameFor(run.runId, testFile, `e${next()}`);
      await maintenance.query(`create database ${quoteIdent(name)} owner ${quoteIdent(PRINCIPALS[owner])}`);
      databases.push(name);
      return {
        name,
        url: (principal, options = {}) => url(principal, { ...options, database: name }),
        admin: () => connectAs("superuser", { database: name, applicationName: "shz-it-empty-admin" })
      };
    },
    oidc,
    stub,
    /** A role name reserved for this harness; close() drops the role. */
    roleName(suffix) {
      const name = temporaryRoleName(run.runId, next(), suffix);
      roles.push(name);
      return name;
    },
    redact: clean,
    roleSpec,
    async close() {
      const log = (message) => process.stderr.write(`WARN harness close: ${clean(message)}\n`);
      for (const created of stubs) await created.close().catch((error) => log(error.message));
      stubs.clear();
      for (const created of pools) await created.end().catch((error) => log(error.message));
      pools.clear();
      for (const client of [...clients]) if (client !== admin) await client.end().catch((error) => log(error.message));
      if (roles.length && database === "clone") {
        for (const role of roles) {
          const exists = await admin.query("select 1 from pg_roles where rolname = $1", [role]).catch(() => ({ rowCount: 0 }));
          if (exists.rowCount) await admin.query(`drop owned by ${quoteIdent(role)}`).catch((error) => log(error.message));
        }
      }
      if (admin !== maintenance) await admin.end().catch((error) => log(error.message));
      if (!keep) {
        for (const name of databases) {
          if (!name.startsWith(DATABASE_PREFIX)) continue;
          await maintenance.query(`drop database if exists ${quoteIdent(name)} with (force)`).catch((error) => log(error.message));
        }
      }
      for (const role of roles) await maintenance.query(`drop role if exists ${quoteIdent(role)}`).catch((error) => log(error.message));
      await maintenance.end().catch((error) => log(error.message));
      for (const directory of tempDirs) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      openHarnesses -= 1;
      if (run.ownsRun && openHarnesses === 0) {
        runPromise = null;
        await cleanupRun({ databaseUrl, runId: run.runId, keep }).catch((error) => log(error.message));
      }
    }
  };
  return harness;
}
