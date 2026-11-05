// Cluster preparation for the shared PostgreSQL integration harness (design part 8, section 1.1):
// business roles with fresh passwords, the migrated template database, and URL / name helpers.
// Used by scripts/run-postgres-integration.mjs (once per run) and by scripts/integration/harness.mjs
// (in-process when a test file runs on its own). The pure helpers are tested locally by
// scripts/test-integration-lib.mjs; the database functions need a superuser DATABASE_URL.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATABASE_PREFIX = "shz_it_";
export const ROLE_PREFIX = "shz_it_r_";
export const PREPARE_LOCK = "shz-it-prepare";
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * The cluster roles the harness manages (section 1.1 role table). Every role is created or altered with all
 * attributes written out: LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION and the listed
 * BYPASSRLS setting. `service: true` marks the principals whose sessions are checked with
 * assertSessionIdentity (no superuser, no BYPASSRLS, no memberships). Add a row here when a new principal
 * appears; its grants come from GRANT_SCRIPTS.
 * @type {readonly { alias: string, name: string, bypassRls: boolean, service: boolean, purpose: string }[]}
 */
export const ROLE_SPECS = Object.freeze([
  { alias: "migration_owner", name: "shuzhiren_migration_owner", bypassRls: true, service: false, purpose: "D4 migration owner; owns the template and every object in it, runs the grant scripts" },
  { alias: "owner_nobypass", name: "shuzhiren_owner_nobypass", bypassRls: false, service: false, purpose: "table owner without BYPASSRLS, only in databases from createEmptyDatabase({ owner })" },
  { alias: "control_plane", name: "shuzhiren_control_plane", bypassRls: false, service: true, purpose: "Control_Plane application account, privileges from control-plane-principal.sql" },
  { alias: "runtime_worker", name: "shuzhiren_runtime_worker", bypassRls: false, service: true, purpose: "service principal, privileges from service-principals.sql" },
  { alias: "channel_adapter", name: "shuzhiren_channel_adapter", bypassRls: false, service: true, purpose: "service principal, privileges from service-principals.sql" },
  { alias: "alert_notifier", name: "shuzhiren_alert_notifier", bypassRls: false, service: true, purpose: "service principal, privileges from service-principals.sql" },
  { alias: "backup", name: "shuzhiren_backup", bypassRls: true, service: false, purpose: "backup reader, privileges from backup-principal.sql" }
].map((spec) => Object.freeze(spec)));

/** Alias → role name; `superuser` is the user of DATABASE_URL. */
export const PRINCIPALS = Object.freeze({ superuser: null, ...Object.fromEntries(ROLE_SPECS.map((spec) => [spec.alias, spec.name])) });
export const SERVICE_PRINCIPALS = Object.freeze(ROLE_SPECS.filter((spec) => spec.service).map((spec) => spec.alias));

/**
 * Grant scripts run by the migration owner against the template, in this order (section 1.1 step 4).
 * `optional: true` marks a script that may not exist yet in this checkout; when it is missing the run
 * continues and reports it (prepareCluster returns it in `skippedGrantScripts`).
 */
export const GRANT_SCRIPTS = Object.freeze([
  Object.freeze({ file: "infra/postgres/service-principals.sql", optional: false }),
  Object.freeze({ file: "infra/postgres/backup-principal.sql", optional: false }),
  Object.freeze({ file: "infra/postgres/control-plane-principal.sql", optional: false })
]);
/** The only psql variable a grant script may use (cross-part ruling 17). */
export const PSQL_VARIABLES = Object.freeze({ control_plane_role: PRINCIPALS.control_plane });

export class SetupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SetupError";
  }
}
export class PsqlScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "PsqlScriptError";
  }
}

export const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text, maxBytes = MAX_IDENTIFIER_BYTES) {
  let bytes = 0;
  let out = "";
  for (const char of String(text)) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/** `<UTC yyyymmddHHMMss>_<4 hex>`. */
export function newRunId(now = new Date(), random = randomBytes(2)) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}_${Buffer.from(random).toString("hex").slice(0, 4).padEnd(4, "0")}`;
}
export const isRunId = (value) => typeof value === "string" && /^\d{14}_[0-9a-f]{4}$/.test(value);

export function templateName(runId) {
  if (!isRunId(runId)) throw new SetupError(`invalid run id ${JSON.stringify(runId)}`);
  return `${DATABASE_PREFIX}${runId}_tpl`;
}

/** File-name slug: lower-case [a-z0-9_], at most 24 characters, the last 4 a hash of the full name. */
export function fileSlug(fileName) {
  const base = path.basename(String(fileName)).replace(/\.test\.mjs$|\.mjs$/, "");
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "file";
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 4);
  return `${clean.slice(0, 19).replace(/_+$/, "")}_${hash}`;
}

/** `shz_it_<runId>_<slug>_<suffix>`; throws when the result exceeds 63 bytes. */
export function databaseNameFor(runId, fileName, suffix) {
  if (!isRunId(runId)) throw new SetupError(`invalid run id ${JSON.stringify(runId)}`);
  if (!/^[a-z0-9]{1,11}$/.test(String(suffix))) throw new SetupError(`invalid database suffix ${JSON.stringify(suffix)}`);
  const name = `${DATABASE_PREFIX}${runId}_${fileSlug(fileName)}_${suffix}`;
  if (Buffer.byteLength(name, "utf8") > MAX_IDENTIFIER_BYTES) throw new SetupError(`database name ${name} exceeds ${MAX_IDENTIFIER_BYTES} bytes`);
  return name;
}

/** Temporary role name for one harness, truncated to 63 bytes. */
export function temporaryRoleName(runId, counter, suffix) {
  const clean = String(suffix).toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "role";
  return truncateUtf8(`${ROLE_PREFIX}${runId}_${counter}_${clean}`);
}

export const UNREPRESENTABLE_DATABASE_CHARS = /[;/?:@&=+$,#]/;

/**
 * Derives a connection URL from `baseUrl` (section 1.3 `url()`): only the user name, password and database
 * name change (each through encodeURIComponent); host, port and every query parameter stay. An
 * `applicationName` becomes the `application_name` query parameter, truncated to 63 bytes.
 */
export function deriveUrl(baseUrl, { user, password, database, applicationName } = {}) {
  const url = new URL(baseUrl);
  if (user !== undefined) url.username = encodeURIComponent(user);
  if (password !== undefined) url.password = encodeURIComponent(password);
  if (database !== undefined) {
    // node-postgres (pg-connection-string) decodes the path with decodeURI, which leaves %23, %2F, %3F and the
    // other reserved escapes encoded, so such a database name cannot be expressed in a URL at all.
    if (UNREPRESENTABLE_DATABASE_CHARS.test(database)) throw new SetupError(`database name ${JSON.stringify(database)} contains a character node-postgres cannot decode from a URL path`);
    url.pathname = `/${encodeURIComponent(database)}`;
  }
  if (applicationName !== undefined) url.searchParams.set("application_name", truncateUtf8(applicationName));
  return url.toString();
}

export function databaseOf(databaseUrl) {
  const url = new URL(databaseUrl);
  return decodeURIComponent(url.pathname.replace(/^\//, "")) || decodeURIComponent(url.username);
}

/** Replaces every occurrence of a known secret with `[redacted]`. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  const values = [...new Set(secrets.filter((value) => typeof value === "string" && value.length >= 4))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join("[redacted]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join("[redacted]");
  }
  return out;
}

/**
 * psql variable substitution for grant scripts (cross-part ruling 17). Outside string literals, quoted
 * identifiers, dollar quotes and comments, `:"name"` is replaced by the quoted identifier from `variables`;
 * any other psql variable form (`:name`, `:'name'`, an unknown `:"name"`) or a backslash meta-command throws
 * PsqlScriptError. `::` casts and `:=` are left alone.
 */
export function substitutePsqlVariables(sql, variables = PSQL_VARIABLES) {
  const text = String(sql);
  let out = "";
  let i = 0;
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      if (depth > 0) throw new PsqlScriptError(`unterminated block comment at line ${lineOf(i)}`);
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (char === "'") {
      const escapes = /[eE]/.test(text[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(text[i - 2] ?? "");
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new PsqlScriptError(`unterminated string literal at line ${lineOf(i)}`);
        if (escapes && text[j] === "\\") { j += 2; continue; }
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new PsqlScriptError(`unterminated quoted identifier at line ${lineOf(i)}`);
        if (text[j] === '"') {
          if (text[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === "$" && !/[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw new PsqlScriptError(`unterminated dollar quote ${tag[0]} at line ${lineOf(i)}`);
        out += text.slice(i, close + tag[0].length);
        i = close + tag[0].length;
        continue;
      }
    }
    if (char === "\\") throw new PsqlScriptError(`psql meta-command at line ${lineOf(i)} is not supported`);
    if (char === ":") {
      if (next === ":") { out += "::"; i += 2; continue; }
      if (next === '"') {
        const close = text.indexOf('"', i + 2);
        const name = close < 0 ? "" : text.slice(i + 2, close);
        if (close < 0 || !Object.hasOwn(variables, name)) throw new PsqlScriptError(`psql variable :"${name}" at line ${lineOf(i)} is not supported; only ${Object.keys(variables).map((key) => `:"${key}"`).join(", ")} is`);
        out += quoteIdent(variables[name]);
        i = close + 1;
        continue;
      }
      if (next === "'" || /[A-Za-z_{]/.test(next ?? "")) throw new PsqlScriptError(`psql variable at line ${lineOf(i)} is not supported; only ${Object.keys(variables).map((key) => `:"${key}"`).join(", ")} is`);
    }
    out += char;
    i += 1;
  }
  return out;
}

export function roleSpec(alias) {
  return ROLE_SPECS.find((spec) => spec.alias === alias);
}

/** SQL that creates or alters one role with every attribute written out. */
export function roleStatements(spec, password) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new SetupError(`generated password for ${spec.name} has an unexpected format`);
  const attributes = `login noinherit nosuperuser nocreatedb nocreaterole noreplication ${spec.bypassRls ? "bypassrls" : "nobypassrls"} password ${quoteLiteral(password)}`;
  return [
    `do $$ begin if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(spec.name)}) then create role ${quoteIdent(spec.name)} ${attributes.replace(/ password .*$/, "")}; end if; end $$`,
    `alter role ${quoteIdent(spec.name)} with ${attributes}`
  ];
}

/** Compares pg_roles rows with ROLE_SPECS; returns one message per mismatch. */
export function roleAttributeProblems(rows, specs = ROLE_SPECS) {
  const problems = [];
  for (const spec of specs) {
    const row = rows.find((candidate) => candidate.rolname === spec.name);
    if (!row) { problems.push(`${spec.name} is missing`); continue; }
    const expected = { rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: spec.bypassRls };
    for (const [column, value] of Object.entries(expected)) {
      if (row[column] !== value) problems.push(`${spec.name} ${column} is ${row[column]}, expected ${value}`);
    }
    if (Number(row.memberships) !== 0) problems.push(`${spec.name} is a member of ${row.memberships} role(s)`);
  }
  return problems;
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new SetupError(`cannot connect to DATABASE_URL: ${error.message}`, { cause: error });
  }
  return client;
}

/** Connects with the superuser DATABASE_URL and checks the session is a superuser. */
export async function connectSuperuser(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") throw new SetupError("DATABASE_URL is not set; set it to a PostgreSQL superuser connection string");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new SetupError("DATABASE_URL is not a valid URL");
  }
  if (databaseOf(parsed.toString()).startsWith(DATABASE_PREFIX)) throw new SetupError(`DATABASE_URL must not point at a ${DATABASE_PREFIX}* database`);
  const client = await connect(databaseUrl);
  const identity = await client.query("select session_user::text as session_user, r.rolsuper from pg_roles r where r.rolname = session_user");
  if (identity.rows[0]?.rolsuper !== true) {
    await client.end().catch(() => undefined);
    throw new SetupError(`DATABASE_URL user ${identity.rows[0]?.session_user ?? "?"} is not a superuser`);
  }
  return client;
}

/** Drops databases of other runs that have no connections; fails when another run is still connected. */
async function dropStaleDatabases(admin, runId, log) {
  const active = await admin.query("select distinct datname from pg_stat_activity where datname like 'shz\\_it\\_%' and pid <> pg_backend_pid()");
  const foreign = active.rows.map((row) => row.datname).filter((name) => !name.startsWith(`${DATABASE_PREFIX}${runId}_`));
  if (foreign.length) throw new SetupError(`another integration run is active on this cluster (connected databases: ${foreign.join(", ")})`);
  const stale = await admin.query("select datname from pg_database where datname like 'shz\\_it\\_%' order by datname");
  for (const { datname } of stale.rows) {
    if (datname.startsWith(`${DATABASE_PREFIX}${runId}_`)) continue;
    await admin.query(`alter database ${quoteIdent(datname)} with allow_connections true`).catch(() => undefined);
    await admin.query(`drop database if exists ${quoteIdent(datname)} with (force)`);
    log(`dropped stale database ${datname}`);
  }
  const roles = await admin.query("select rolname from pg_roles where rolname like 'shz\\_it\\_r\\_%' order by rolname");
  for (const { rolname } of roles.rows) {
    if (rolname.startsWith(`${ROLE_PREFIX}${runId}_`)) continue;
    await admin.query(`drop role if exists ${quoteIdent(rolname)}`).then(() => log(`dropped stale role ${rolname}`), () => undefined);
  }
}

/** Runs apps/console/scripts/migrate.mjs as a child process. */
export function runMigrator({ databaseUrl, migrationsDir, env = {}, timeoutMs = 300_000, secrets = [] }) {
  const args = [path.join(REPO_ROOT, "apps", "console", "scripts", "migrate.mjs")];
  if (migrationsDir) args.push("--migrations-dir", migrationsDir);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, ...env, DATABASE_URL: databaseUrl }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), durationMs: Date.now() - started });
    });
  });
}

/** Reads a grant script, substituting the psql variable; returns null for a missing optional script. */
export function loadGrantScript(entry, root = REPO_ROOT) {
  const file = path.join(root, entry.file);
  if (!existsSync(file)) {
    if (entry.optional) return null;
    throw new SetupError(`grant script ${entry.file} is missing`);
  }
  try {
    return substitutePsqlVariables(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SetupError(`grant script ${entry.file}: ${error.message}`, { cause: error });
  }
}

/**
 * Prepares the cluster once (section 1.1): advisory lock, stale database cleanup, roles with fresh passwords,
 * attribute and membership check, template database built by the real Migrator and the grant scripts, then
 * closed for connections. Throws SetupError on every failure.
 * @returns {Promise<{ runId: string, template: string, secrets: Record<string, string>, skippedGrantScripts: string[], migrations: number }>}
 */
export async function prepareCluster({ databaseUrl = process.env.DATABASE_URL, runId = newRunId(), log = () => undefined } = {}) {
  const admin = await connectSuperuser(databaseUrl);
  const secrets = {};
  const redactAll = (message) => redact(message, [...Object.values(secrets), new URL(databaseUrl).password]);
  let locked = false;
  try {
    await admin.query("select pg_advisory_lock(hashtext($1))", [PREPARE_LOCK]);
    locked = true;
    await dropStaleDatabases(admin, runId, log);
    for (const spec of ROLE_SPECS) {
      const password = randomBytes(24).toString("base64url");
      secrets[spec.name] = password;
      for (const statement of roleStatements(spec, password)) await admin.query(statement);
    }
    const roles = await admin.query(`select r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships
      from pg_roles r where r.rolname = any($1::text[])`, [ROLE_SPECS.map((spec) => spec.name)]);
    const problems = roleAttributeProblems(roles.rows);
    if (problems.length) throw new SetupError(`role check failed: ${problems.join("; ")}`);

    const template = templateName(runId);
    await admin.query(`create database ${quoteIdent(template)} owner ${quoteIdent(PRINCIPALS.migration_owner)}`);
    log(`created template ${template}`);
    const ownerUrl = deriveUrl(databaseUrl, { user: PRINCIPALS.migration_owner, password: secrets[PRINCIPALS.migration_owner], database: template, applicationName: "shz-it-migrator" });
    const migrated = await runMigrator({ databaseUrl: ownerUrl, secrets: Object.values(secrets) });
    if (migrated.status !== 0) throw new SetupError(`template migration failed (exit ${migrated.status ?? migrated.signal}): ${migrated.stderr.trim().split(/\r?\n/).slice(-5).join(" | ")}`);
    const applied = migrated.stdout.split(/\r?\n/).filter((line) => line.startsWith("Applied ")).length;
    log(`migrated template as ${PRINCIPALS.migration_owner} (${applied} migrations)`);

    const skippedGrantScripts = [];
    const owner = await connect(ownerUrl);
    try {
      for (const entry of GRANT_SCRIPTS) {
        const sql = loadGrantScript(entry);
        if (sql === null) {
          skippedGrantScripts.push(entry.file);
          log(`NOTE grant script ${entry.file} does not exist in this checkout; skipped`);
          continue;
        }
        try {
          await owner.query(sql);
        } catch (error) {
          throw new SetupError(`grant script ${entry.file} failed: ${error.message}`, { cause: error });
        }
        log(`applied ${entry.file} as ${PRINCIPALS.migration_owner}`);
      }
    } finally {
      await owner.end().catch(() => undefined);
    }
    await admin.query(`alter database ${quoteIdent(template)} with allow_connections false`);
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [template]);
    return { runId, template, secrets, skippedGrantScripts, migrations: applied };
  } catch (error) {
    if (error instanceof SetupError) { error.message = redactAll(error.message); throw error; }
    throw new SetupError(redactAll(error.message), { cause: error });
  } finally {
    if (locked) await admin.query("select pg_advisory_unlock(hashtext($1))", [PREPARE_LOCK]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

/** Drops the template and every database of this run (unless keep), then the run's temporary roles. */
export async function cleanupRun({ databaseUrl = process.env.DATABASE_URL, runId, keep = false, log = () => undefined }) {
  if (keep) { log(`SHZ_IT_KEEP=true: kept databases of run ${runId}`); return; }
  const admin = await connectSuperuser(databaseUrl);
  try {
    const databases = await admin.query("select datname from pg_database where starts_with(datname, $1) order by datname", [`${DATABASE_PREFIX}${runId}_`]);
    for (const { datname } of databases.rows) {
      await admin.query(`alter database ${quoteIdent(datname)} with allow_connections true`).catch(() => undefined);
      await admin.query(`drop database if exists ${quoteIdent(datname)} with (force)`);
    }
    const roles = await admin.query("select rolname from pg_roles where starts_with(rolname, $1)", [`${ROLE_PREFIX}${runId}_`]);
    for (const { rolname } of roles.rows) await admin.query(`drop role if exists ${quoteIdent(rolname)}`).catch(() => undefined);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
