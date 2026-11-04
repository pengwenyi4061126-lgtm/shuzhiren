import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const migrationLockName = "shuzhiren-schema-migrations";

export async function loadMigrations(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    return { name, sql, checksum: migrationChecksum(sql) };
  }));
}

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
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
