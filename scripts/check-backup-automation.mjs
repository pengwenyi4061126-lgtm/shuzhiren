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
  gatewayRestoreDrill: "../scripts/restore-runtime-gateway-state-drill.sh",
  gatewayRestoreDrillTest: "../scripts/test-runtime-gateway-state-restore-drill.py",
  environment: "../config/backup.example.env",
  gatewayEnvironment: "../config/runtime-gateway-backup.example.env",
  postgresService: "../infra/systemd/shuzhiren-postgres-backup.service",
  postgresTimer: "../infra/systemd/shuzhiren-postgres-backup.timer",
  gatewayService: "../infra/systemd/shuzhiren-runtime-gateway-backup.service",
  gatewayTimer: "../infra/systemd/shuzhiren-runtime-gateway-backup.timer"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));

for (const source of ["DATABASE_URL", 'run_pg pg_dump --dbname="$PG_SAFE_URL" --format=custom', 'pg_restore --list "$temporary"', 'backup_source="database_url"', "flock -n 9", "refusing to overwrite an existing backup"]) {
  if (!contents.postgresBackup.includes(source)) throw new Error(`PostgreSQL backup must support the private production database path: ${source}`);
}
// L14: connection passwords reach libpq through PGPASSWORD, never through argv.
for (const [name, source, forbidden] of [["postgresBackup", contents.postgresBackup, ["--dbname=\"$database_url\"", "pg_dump \"$database_url\""]], ["postgresRestoreDrill", contents.postgresRestoreDrill, ["psql \"$drill_database_url\"", "--dbname=\"$drill_database_url\""]]]) {
  for (const expected of ["pg_url_split() {", 'PGPASSWORD="$PG_URL_PASSWORD" "$@"']) if (!source.includes(expected)) throw new Error(`${name} must move the database password out of client argv: ${expected}`);
  for (const text of forbidden) if (source.includes(text)) throw new Error(`${name} must not pass the password-bearing database URL in argv: ${text}`);
  // Every connecting client call; `--list` reads a local archive and the Compose fallback runs inside the dev container.
  const clientCalls = source.split("\n").filter((line) => /(^|[\s($])(psql|pg_dump|pg_restore)\s/.test(line) && !/^\s*(#|command -v|\[\[)/.test(line) && !line.includes("--list") && !line.includes("docker compose"));
  if (clientCalls.length === 0) throw new Error(`${name} must connect through run_pg`);
  for (const line of clientCalls) if (!line.includes("run_pg ") || !line.includes('"$PG_SAFE_URL"')) throw new Error(`${name} connects without the password-free URL: ${line.trim()}`);
}
for (const source of ["LOGIN NOINHERIT BYPASSRLS", "grant select on all tables in schema public to shuzhiren_backup", "grant usage, select on all sequences in schema public to shuzhiren_backup", "alter default privileges in schema public grant select on tables to shuzhiren_backup", "must not inherit memberships"]) {
  if (!contents.backupPrincipal.includes(source)) throw new Error(`Backup database principal must retain its isolated read-only grant model: ${source}`);
}
for (const source of ['pg_restore --list "$backup_file"', "pg_restore or docker is required", 'manifest_file="${backup_file%.dump}.manifest"', "Backup manifest archive does not match BACKUP_FILE", "Backup bytes do not match backup manifest"]) {
  if (!contents.postgresVerify.includes(source)) throw new Error(`PostgreSQL backup verifier must work without a Compose database: ${source}`);
}
for (const source of ["DATABASE_URL='postgresql://backup-user:backup-p%40ss%3Aw%2Frd%25@private-postgres:5432/shuzhiren?sslmode=require'", '[[ "${PGPASSWORD-}" == "backup-p@ss:w/rd%" ]]', "source=database_url", "verify-postgres-backup.sh", "another PostgreSQL backup is already running"]) {
  if (!contents.postgresDirectTest.includes(source)) throw new Error(`PostgreSQL direct backup test must cover ${source}`);
}
for (const source of ["DRILL_DATABASE_URL", "DRILL_EVIDENCE_FILE", "RESTORE_DRILL_CONFIRM", "shuzhiren_restore_[a-z0-9_]+", "restore drill target database must be empty", "pg_restore --exit-on-error --no-owner --no-privileges", "migration_count"]) {
  if (!contents.postgresRestoreDrill.includes(source)) throw new Error(`PostgreSQL restore drill must remain isolated and evidenced: ${source}`);
}
for (const source of ["shuzhiren_restore_fixture", "must target an isolation database", "RESTORE_DRILL_CONFIRM", "pgpassword:${decoded_password}", "restore drill passed the database password in a client argv"]) {
  if (!contents.postgresRestoreDrillTest.includes(source)) throw new Error(`PostgreSQL restore drill test must cover ${source}`);
}
if (!contents.gatewayBackup.includes("GATEWAY_BACKUP_DIR")) throw new Error("Gateway backup must support its dedicated scheduled backup directory");
for (const source of ['manifest_file="${backup_file%.sqlite3}.manifest"', "Gateway backup manifest snapshot does not match BACKUP_FILE", "Gateway backup bytes do not match gateway backup manifest"]) {
  if (!contents.gatewayVerify?.includes(source)) throw new Error(`Gateway backup verifier must bind the snapshot to its manifest: ${source}`);
}
for (const source of ["DRILL_GATEWAY_STATE_PATH", "DRILL_EVIDENCE_FILE", "DRILL_GATEWAY_UID", "DRILL_GATEWAY_BACKUP_GROUP", "RESTORE_DRILL_CONFIRM", "must not equal RUNTIME_GATEWAY_STATE_PATH", "must be empty", "gateway_started=false", "chmod 0640"]) {
  if (!contents.gatewayRestoreDrill.includes(source)) throw new Error(`Gateway restore drill must remain isolated and evidenced: ${source}`);
}
for (const source of ["fail_on_replay", "fail_on_synthesis", "fail_on_audio", "completed_command_rows=2", "must not call LiveTalking", "must not call CosyVoice", "must be empty"]) {
  if (!contents.gatewayRestoreDrillTest.includes(source)) throw new Error(`Gateway restore drill test must prove restored completed commands do not replay: ${source}`);
}
function envKeys(text) {
  return new Map(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
const postgresEnvironment = envKeys(contents.environment);
const gatewayEnvironment = envKeys(contents.gatewayEnvironment);
for (const key of ["DATABASE_URL", "POSTGRES_BACKUP_DIR"]) if (!postgresEnvironment.has(key)) throw new Error(`PostgreSQL backup environment template must document ${key}`);
for (const key of ["GATEWAY_BACKUP_DIR", "RUNTIME_GATEWAY_STATE_PATH", "DRILL_GATEWAY_STATE_PATH", "DRILL_EVIDENCE_FILE"]) if (!gatewayEnvironment.has(key)) throw new Error(`Gateway backup environment template must document ${key}`);
// L12: the Gateway backup unit must not load the PostgreSQL credential.
for (const key of gatewayEnvironment.keys()) if (/DATABASE_URL|PGPASS|POSTGRES/.test(key)) throw new Error(`Gateway backup environment template must not carry PostgreSQL credentials: ${key}`);
for (const key of postgresEnvironment.keys()) if (/GATEWAY|DRILL_/.test(key)) throw new Error(`PostgreSQL backup environment template must only configure the PostgreSQL unit: ${key}`);

function unitDirectives(text) {
  const directives = new Map();
  for (const line of text.split(/\r?\n/).map((item) => item.trim())) {
    if (!line || line.startsWith("#") || line.startsWith("[") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("="));
    directives.set(key, [...(directives.get(key) ?? []), line.slice(line.indexOf("=") + 1)]);
  }
  return directives;
}
const units = {
  postgresService: { directives: unitDirectives(contents.postgresService), template: postgresEnvironment, writable: ["POSTGRES_BACKUP_DIR"], readonly: [] },
  gatewayService: { directives: unitDirectives(contents.gatewayService), template: gatewayEnvironment, writable: ["GATEWAY_BACKUP_DIR"], readonly: ["RUNTIME_GATEWAY_STATE_PATH"] }
};
for (const [name, { directives, template, writable, readonly }] of Object.entries(units)) {
  const only = (key) => {
    const values = directives.get(key) ?? [];
    if (values.length !== 1) throw new Error(`Scheduled backup ${name} must declare exactly one ${key}=`);
    return values[0];
  };
  if (!/^[1-9]\d*(s|min|h)$/.test(only("TimeoutStartSec"))) throw new Error(`Scheduled backup ${name} must bound its run time with TimeoutStartSec=<n>s|min|h`);
  if (only("EnvironmentFile") !== only("ConditionPathExists")) throw new Error(`Scheduled backup ${name} must condition on its own EnvironmentFile`);
  if (!only("EnvironmentFile").startsWith("/etc/shuzhiren/")) throw new Error(`Scheduled backup ${name} must load its private environment from /etc/shuzhiren/`);
  for (const [directive, keys] of [["ReadWritePaths", writable], ["ReadOnlyPaths", readonly]]) {
    for (const key of keys) if (only(directive) !== template.get(key)) throw new Error(`Scheduled backup ${name} ${directive}= must equal ${key} of its environment template`);
    if (keys.length && !contents[name].includes(`#   ${directive}=\n`) && !contents[name].includes(`#   ${directive}=\r\n`)) throw new Error(`Scheduled backup ${name} must document the ${directive}= drop-in reset for other directories`);
  }
}
if (units.postgresService.directives.get("EnvironmentFile")[0] === units.gatewayService.directives.get("EnvironmentFile")[0]) throw new Error("PostgreSQL and Gateway backup units must not share an EnvironmentFile");
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
