import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const migrationLockName = "shuzhiren-schema-migrations";

// Migration files are read as bytes and every CR LF pair is replaced with LF before hashing and executing, so a
// Windows checkout with core.autocrlf=true and an LF checkout produce the same checksum and the same SQL. A file
// without CR hashes to the SHA-256 of its exact bytes, which is what schema_migrations already records.
export async function loadMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => {
    const bytes = normalizeMigrationBytes(await readFile(path.join(directory, name)));
    return { name, sql: bytes.toString("utf8"), checksum: sha256Hex(bytes) };
  }));
}

/** Replaces each CR LF pair with LF. A CR that is not followed by LF is kept, so it still changes the checksum. */
export function normalizeMigrationBytes(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!source.includes(0x0d)) return source;
  const result = Buffer.allocUnsafe(source.length);
  let length = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === 0x0d && source[index + 1] === 0x0a) continue;
    result[length] = source[index];
    length += 1;
  }
  return result.subarray(0, length);
}

/** SHA-256 hex of the normalized migration content; a string is encoded as UTF-8 first. */
export function migrationChecksum(content) {
  return sha256Hex(normalizeMigrationBytes(typeof content === "string" ? Buffer.from(content, "utf8") : content));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureMigrationLedger(client) {
  await client.query("create table if not exists schema_migrations (name text primary key, checksum text not null constraint schema_migrations_checksum_format check (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz not null default now())");
  await client.query("alter table schema_migrations add column if not exists checksum text");
}

export async function enforceMigrationLedgerIntegrity(client) {
  await client.query("alter table schema_migrations alter column checksum set not null");
  await client.query(`do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'schema_migrations_checksum_format' and conrelid = 'schema_migrations'::regclass) then
      alter table schema_migrations add constraint schema_migrations_checksum_format check (checksum ~ '^[0-9a-f]{64}$');
    end if;
  end $$;`);
}

const timeoutVariables = { lockTimeoutMs: ["MIGRATION_LOCK_TIMEOUT_MS", 10_000], statementTimeoutMs: ["MIGRATION_STATEMENT_TIMEOUT_MS", 1_800_000] };

/**
 * lock_timeout and statement_timeout for each migration transaction, in milliseconds. A migration that waits
 * behind application locks fails after lock_timeout instead of queueing every later query behind its own
 * lock. A migration file can still override either value with SET LOCAL.
 */
export function migrationTimeouts(env) {
  const result = {};
  for (const [key, [name, fallback]] of Object.entries(timeoutVariables)) {
    const raw = env[name];
    if (raw === undefined || raw === "") { result[key] = fallback; continue; }
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 86_400_000) throw new Error(`${name} must be an integer between 1 and 86400000`);
    result[key] = Number(raw);
  }
  return result;
}

/** Files that sort before the newest recorded migration but are not recorded; applying them now would run out of order. */
export function findOutOfOrderMigrations(appliedNames, migrations) {
  let newestApplied = null;
  for (const name of appliedNames) if (newestApplied === null || name > newestApplied) newestApplied = name;
  if (newestApplied === null) return [];
  return migrations.filter((migration) => !appliedNames.has(migration.name) && migration.name < newestApplied);
}

/** Wraps a failure of one migration file so the message names the file and a lock or statement timeout. */
export function migrationFailure(name, error) {
  const timeout = error?.code === "55P03" ? " (lock_timeout)" : error?.code === "57014" ? " (statement_timeout)" : "";
  return new Error(`migration ${name} failed: ${error instanceof Error ? error.message : String(error)}${timeout}`, { cause: error });
}

export function assertKnownMigrationLedger(appliedRows, migrations) {
  const known = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const row of appliedRows) {
    const migration = known.get(row.name);
    if (!migration) throw new Error(`database records migration ${row.name}, but that file is missing from this checkout`);
    if (!row.checksum) throw new Error(`migration checksum baseline is required before continuing; run npm run db:migrate:checksum-baseline -- --approve-current-files as the migration schema owner after reviewing the recorded files`);
    if (row.checksum !== migration.checksum) throw new Error(`migration checksum drift detected for ${row.name}; applied=${row.checksum} current=${migration.checksum}`);
  }
}

/** Migrations numbered at least this high change existing rows only through 079's migration_fix_* functions. */
export const firstGuardedDataFixMigration = 79;

/**
 * Data-fix statements a guarded migration runs without migration_fix_*: top-level UPDATE, DELETE, MERGE,
 * INSERT ... SELECT and data-modifying WITH, and the same statements inside a DO block. Comments, string literals
 * and the bodies of CREATE FUNCTION / CREATE PROCEDURE are not inspected; INSERT ... VALUES is allowed.
 * Returns [{ line, statement }] with the 1-based line where each statement starts and its original text.
 */
export function findUnguardedDataFixStatements(sql) {
  const { masked, dollarBodies } = maskSql(sql);
  const violations = [];
  for (const { start, end } of topLevelStatements(masked)) {
    const text = masked.slice(start, end);
    const leading = text.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
    if (!leading) continue;
    const offset = start + text.search(/\S/);
    const report = () => violations.push({ line: lineAt(sql, offset), statement: sql.slice(offset, end).trim() });
    if (leading === "create" && /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(text)) continue;
    if (leading === "do") {
      for (const body of dollarBodies.filter((candidate) => candidate.bodyStart >= start && candidate.bodyEnd <= end)) {
        if (plpgsqlBodyModifiesData(sql.slice(body.bodyStart, body.bodyEnd))) { report(); break; }
      }
      continue;
    }
    if (statementModifiesData(text)) report();
  }
  return violations;
}

/** Pending migrations numbered >= 079 must not contain unguarded data-fix statements; checked before any is applied. */
export function assertGuardedDataFixes(migrations) {
  const errors = [];
  for (const migration of migrations) {
    const number = Number.parseInt(migration.name.match(/^(\d+)_/)?.[1] ?? "", 10);
    if (!(number >= firstGuardedDataFixMigration)) continue;
    for (const violation of findUnguardedDataFixStatements(migration.sql)) errors.push(`${migration.name}:${violation.line}`);
  }
  if (errors.length) throw new Error(`unguarded data-fix statements (use migration_fix_update, migration_fix_delete or migration_fix_insert): ${errors.join(", ")}`);
}

function statementModifiesData(text) {
  const leading = text.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
  if (leading === "update" || leading === "delete" || leading === "merge") return true;
  if (leading === "insert") return /\bselect\b/i.test(text);
  if (leading === "with") return /\b(?:update|delete|merge|insert)\b/i.test(text);
  return false;
}

function plpgsqlBodyModifiesData(body) {
  const { masked } = maskSql(body);
  // A PL/pgSQL statement starts the body, follows a ';', or follows BEGIN, THEN, ELSE or LOOP. FOR UPDATE and
  // ON CONFLICT DO UPDATE are not at a statement start.
  for (const piece of masked.split(";")) {
    const statement = piece.replace(/^(?:\s*(?:<<\s*\w+\s*>>|begin|then|else|loop|declare)\b)*/i, "");
    if (statementModifiesData(statement)) return true;
    if (/\b(?:begin|then|else|loop)\s+(?:update|delete|merge)\b/i.test(piece)) return true;
    if (/\b(?:begin|then|else|loop)\s+insert\b[\s\S]*\bselect\b/i.test(piece)) return true;
    if (/\b(?:begin|then|else|loop)\s+with\b[\s\S]*\b(?:update|delete|merge|insert)\b/i.test(piece)) return true;
  }
  return false;
}

function topLevelStatements(masked) {
  const statements = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) { statements.push({ start, end: index }); start = index + 1; }
  }
  if (masked.slice(start).trim()) statements.push({ start, end: masked.length });
  return statements;
}

function lineAt(sql, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (sql[index] === "\n") line += 1;
  return line;
}

/**
 * Replaces comments, string literals, quoted identifiers and dollar-quoted bodies with spaces (newlines are kept,
 * so offsets and line numbers still match the input) and lists each dollar-quoted body's range.
 */
function maskSql(sql) {
  const out = sql.split("");
  const dollarBodies = [];
  const blank = (from, to) => { for (let index = from; index < to; index += 1) if (out[index] !== "\n") out[index] = " "; };
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end < 0 ? sql.length : end;
      blank(index, stop);
      index = stop;
    } else if (character === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*") { depth += 1; cursor += 2; }
        else if (sql[cursor] === "*" && sql[cursor + 1] === "/") { depth -= 1; cursor += 2; }
        else cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
    } else if (character === "'") {
      const escapes = /[eE]/.test(sql[index - 1] ?? "") && !/[A-Za-z0-9_$]/.test(sql[index - 2] ?? "");
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (escapes && sql[cursor] === "\\") { cursor += 2; continue; }
        if (sql[cursor] === "'") { if (sql[cursor + 1] === "'") { cursor += 2; continue; } break; }
        cursor += 1;
      }
      blank(index, Math.min(sql.length, cursor + 1));
      index = cursor + 1;
    } else if (character === "\"") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "\"") { if (sql[cursor + 1] === "\"") { cursor += 2; continue; } break; }
        cursor += 1;
      }
      blank(index + 1, Math.min(sql.length, cursor));
      index = cursor + 1;
    } else if (character === "$" && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? "")) {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (!tag) { index += 1; continue; }
      const bodyStart = index + tag.length;
      const close = sql.indexOf(tag, bodyStart);
      const bodyEnd = close < 0 ? sql.length : close;
      const stop = close < 0 ? sql.length : close + tag.length;
      dollarBodies.push({ bodyStart, bodyEnd });
      blank(index, stop);
      index = stop;
    } else {
      index += 1;
    }
  }
  return { masked: out.join(""), dollarBodies };
}
