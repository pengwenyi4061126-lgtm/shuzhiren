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

export function assertKnownMigrationLedger(appliedRows, migrations) {
  const known = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const row of appliedRows) {
    const migration = known.get(row.name);
    if (!migration) throw new Error(`database records migration ${row.name}, but that file is missing from this checkout`);
    if (!row.checksum) throw new Error(`migration checksum baseline is required before continuing; run npm run db:migrate:checksum-baseline -- --approve-current-files as the migration schema owner after reviewing the recorded files`);
    if (row.checksum !== migration.checksum) throw new Error(`migration checksum drift detected for ${row.name}; applied=${row.checksum} current=${migration.checksum}`);
  }
}
