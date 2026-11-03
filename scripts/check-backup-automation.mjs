import { readFile } from "node:fs/promises";

const files = {
  postgresBackup: "../scripts/backup-postgres.sh",
  postgresVerify: "../scripts/verify-postgres-backup.sh",
  gatewayBackup: "../scripts/backup-runtime-gateway-state.sh",
  environment: "../config/backup.example.env",
  postgresService: "../infra/systemd/shuzhiren-postgres-backup.service",
  postgresTimer: "../infra/systemd/shuzhiren-postgres-backup.timer",
  gatewayService: "../infra/systemd/shuzhiren-runtime-gateway-backup.service",
  gatewayTimer: "../infra/systemd/shuzhiren-runtime-gateway-backup.timer"
};
const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, await readFile(new URL(file, import.meta.url), "utf8")])));

for (const source of ["DATABASE_URL", 'pg_dump --dbname="$database_url" --format=custom', 'pg_restore --list "$temporary"', 'backup_source="database_url"']) {
  if (!contents.postgresBackup.includes(source)) throw new Error(`PostgreSQL backup must support the private production database path: ${source}`);
}
for (const source of ['pg_restore --list "$backup_file"', "pg_restore or docker is required"]) {
  if (!contents.postgresVerify.includes(source)) throw new Error(`PostgreSQL backup verifier must work without a Compose database: ${source}`);
}
if (!contents.gatewayBackup.includes("GATEWAY_BACKUP_DIR")) throw new Error("Gateway backup must support its dedicated scheduled backup directory");
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
