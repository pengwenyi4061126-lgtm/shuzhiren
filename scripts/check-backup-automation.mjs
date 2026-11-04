import { readFile } from "node:fs/promises";

const files = {
  postgresBackup: "../scripts/backup-postgres.sh",
  backupPrincipal: "../infra/postgres/backup-principal.sql",
  postgresVerify: "../scripts/verify-postgres-backup.sh",
  postgresDirectTest: "../scripts/test-postgres-backup-direct.sh",
  postgresRestoreDrill: "../scripts/restore-postgres-drill.sh",
  postgresRestoreDrillTest: "../scripts/test-postgres-restore-drill.sh",
  gatewayBackup: "../scripts/backup-runtime-gateway-state.sh",
  gatewayVerify: "../scripts/verify-runtime-gateway-state-backup.sh",
  environment: "../config/backup.example.env",
  postgresService: "../infra/systemd/shuzhiren-postgres-backup.service",
  postgresTimer: "../infra/systemd/shuzhiren-postgres-backup.timer",
  gatewayService: "../infra/systemd/shuzhiren-runtime-gateway-backup.service",
  gatewayTimer: "../infra/systemd/shuzhiren-runtime-gateway-backup.timer"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));

for (const source of ["DATABASE_URL", 'pg_dump --dbname="$database_url" --format=custom', 'pg_restore --list "$temporary"', 'backup_source="database_url"', "flock -n 9", "refusing to overwrite an existing backup"]) {
  if (!contents.postgresBackup.includes(source)) throw new Error(`PostgreSQL backup must support the private production database path: ${source}`);
}
for (const source of ["LOGIN NOINHERIT BYPASSRLS", "grant select on all tables in schema public to shuzhiren_backup", "grant usage, select on all sequences in schema public to shuzhiren_backup", "alter default privileges in schema public grant select on tables to shuzhiren_backup", "must not inherit memberships"]) {
  if (!contents.backupPrincipal.includes(source)) throw new Error(`Backup database principal must retain its isolated read-only grant model: ${source}`);
}
for (const source of ['pg_restore --list "$backup_file"', "pg_restore or docker is required", 'manifest_file="${backup_file%.dump}.manifest"', "Backup manifest archive does not match BACKUP_FILE", "Backup bytes do not match backup manifest"]) {
  if (!contents.postgresVerify.includes(source)) throw new Error(`PostgreSQL backup verifier must work without a Compose database: ${source}`);
}
for (const source of ["DATABASE_URL='postgresql://backup-user:backup-password@private-postgres:5432/shuzhiren'", "source=database_url", "verify-postgres-backup.sh", "another PostgreSQL backup is already running"]) {
  if (!contents.postgresDirectTest.includes(source)) throw new Error(`PostgreSQL direct backup test must cover ${source}`);
}
for (const source of ["DRILL_DATABASE_URL", "DRILL_EVIDENCE_FILE", "RESTORE_DRILL_CONFIRM", "shuzhiren_restore_[a-z0-9_]+", "restore drill target database must be empty", "pg_restore --exit-on-error --no-owner --no-privileges", "migration_count"]) {
  if (!contents.postgresRestoreDrill.includes(source)) throw new Error(`PostgreSQL restore drill must remain isolated and evidenced: ${source}`);
}
for (const source of ["shuzhiren_restore_fixture", "must target an isolation database", "RESTORE_DRILL_CONFIRM"]) {
  if (!contents.postgresRestoreDrillTest.includes(source)) throw new Error(`PostgreSQL restore drill test must cover ${source}`);
}
if (!contents.gatewayBackup.includes("GATEWAY_BACKUP_DIR")) throw new Error("Gateway backup must support its dedicated scheduled backup directory");
for (const source of ['manifest_file="${backup_file%.sqlite3}.manifest"', "Gateway backup manifest snapshot does not match BACKUP_FILE", "Gateway backup bytes do not match gateway backup manifest"]) {
  if (!contents.gatewayVerify?.includes(source)) throw new Error(`Gateway backup verifier must bind the snapshot to its manifest: ${source}`);
}
for (const source of ["POSTGRES_BACKUP_DIR", "GATEWAY_BACKUP_DIR", "RUNTIME_GATEWAY_STATE_PATH"]) {
  if (!contents.environment.includes(source)) throw new Error(`Backup environment template must document ${source}`);
}
for (const [name, source] of [["postgresService", contents.postgresService], ["gatewayService", contents.gatewayService]]) {
  for (const expected of ["User=shuzhiren-backup", "Group=shuzhiren-backup", "NoNewPrivileges=true", "ProtectSystem=strict"]) {
    if (!source.includes(expected)) throw new Error(`Scheduled backup ${name} must retain least-privilege controls: ${expected}`);
  }
}
for (const [name, source] of [["postgresTimer", contents.postgresTimer], ["gatewayTimer", contents.gatewayTimer]]) {
  for (const expected of ["OnUnitActiveSec=15min", "Persistent=true"]) {
    if (!source.includes(expected)) throw new Error(`Scheduled backup ${name} must retain the 15-minute recovery-point objective: ${expected}`);
  }
}

console.log("PASS  production backup automation supports private PostgreSQL and least-privilege 15-minute scheduling");
