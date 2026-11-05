import { readFile } from "node:fs/promises";
import { lexSql, splitStatements, substitutePsqlIdentifierVariable } from "./lib/sql-lexer.mjs";

const [grants, backupGrants, migration, worker, compose, runtime, channel, notifier] = await Promise.all([
  readFile(new URL("../infra/postgres/service-principals.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/backup-principal.sql", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/056_service_actor_security.sql", import.meta.url), "utf8"),
  readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.runtime.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/runtime.example.env", import.meta.url), "utf8"),
  readFile(new URL("../config/channel-adapter.example.env", import.meta.url), "utf8"),
  readFile(new URL("../config/alert-notifier.example.env", import.meta.url), "utf8")
]);

for (const principal of ["shuzhiren_runtime_worker", "shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) {
  if (!grants.includes(`'${principal}'`)) throw new Error(`Service principal grant file must require ${principal}`);
}
for (const source of ["shuzhiren_backup", "LOGIN NOINHERIT BYPASSRLS", "grant select on all tables in schema public to shuzhiren_backup", "grant usage, select on all sequences in schema public to shuzhiren_backup", "alter default privileges in schema public grant select on tables to shuzhiren_backup"]) if (!backupGrants.includes(source)) throw new Error(`Backup principal grant file missing: ${source}`);
for (const forbidden of ["grant insert", "grant update", "grant delete", "grant execute", "grant all"]) if (backupGrants.toLowerCase().includes(forbidden)) throw new Error(`Backup principal grants must not include: ${forbidden}`);
for (const source of ["security definer", "runtime_worker_actor(requested_tenant_id uuid, requested_subject text)", "requested_subject not in ('runtime-worker', 'runtime-scheduler', 'runtime-watchdog')", "revoke all on function runtime_worker_actor(uuid, text) from public"]) {
  if (!migration.includes(source)) throw new Error(`Worker service-actor migration missing: ${source}`);
}
if (worker.includes("sync_control_plane_actor(") || !worker.includes("runtime_worker_actor($1::uuid")) throw new Error("Runtime worker must use only the dedicated worker actor function");
for (const source of [
  "grant select, insert, update on channel_webhook_replays to shuzhiren_channel_adapter",
  "grant select on runtime_alerts to shuzhiren_alert_notifier",
  "grant select, insert, update on alert_notification_deliveries to shuzhiren_alert_notifier",
  "grant select, update on outbox_events to shuzhiren_runtime_worker",
  "grant select, update on live_runs to shuzhiren_runtime_worker",
  "grant select on show_revision_segments to shuzhiren_runtime_worker",
  "grant select (tenant_id, show_revision_id, media_asset_id, kind) on show_revision_media_assets to shuzhiren_runtime_worker",
  "grant select (id, runtime_voice_id, checksum, approval_status, expires_at) on media_assets to shuzhiren_runtime_worker",
  "grant insert on audit_events to shuzhiren_runtime_worker",
  "grant execute on function runtime_worker_actor(uuid, text) to shuzhiren_runtime_worker"
]) if (!grants.includes(source)) throw new Error(`Service principal grants missing: ${source}`);
// The worker reads the voice binding by column only; a table-wide grant would expose asset evidence.
for (const forbidden of ["grant select on media_assets", "grant select on show_revision_media_assets"]) if (grants.toLowerCase().includes(forbidden)) throw new Error(`Service principal grants must stay column-scoped: ${forbidden}`);
for (const forbidden of ["grant all", "grant delete", " on memberships to shuzhiren_", " on users to shuzhiren_", " on products to shuzhiren_", " on show_revisions to shuzhiren_", " on audit_chain_heads to shuzhiren_"]) {
  if (grants.toLowerCase().includes(forbidden)) throw new Error(`Service principal grants must not include: ${forbidden}`);
}
// D4: the control-plane account owns nothing; control-plane-principal.sql grants it DML through the only psql
// variable :"control_plane_role", starting with a full revoke so the file can be run again.
{
  const controlPlaneGrants = await readFile(new URL("../infra/postgres/control-plane-principal.sql", import.meta.url), "utf8");
  // Throws unless :"control_plane_role" is the only psql variable and there is no meta-command.
  const resolved = substitutePsqlIdentifierVariable(controlPlaneGrants, "control_plane_role", "shuzhiren_control_plane");
  const statements = splitStatements(lexSql(resolved).tokens).map((statement) => resolved.slice(statement.start, statement.end).replace(/\s+/g, " ").trim().toLowerCase());
  const role = "\"shuzhiren_control_plane\"";
  const expected = [
    `revoke all privileges on all tables in schema public from ${role}`,
    `revoke all privileges on all sequences in schema public from ${role}`,
    `grant usage on schema public to ${role}`,
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
    `revoke insert, update, delete on schema_migrations from ${role}`,
    `revoke insert, update, delete on audit_chain_heads from ${role}`,
    `revoke all privileges on membership_admin_guards from ${role}`,
    `grant usage, select on all sequences in schema public to ${role}`,
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
    `alter default privileges in schema public grant usage, select on sequences to ${role}`
  ];
  if (JSON.stringify(statements) !== JSON.stringify(expected)) throw new Error(`control-plane-principal.sql must contain exactly these statements in order:\n${expected.join(";\n")};\nfound:\n${statements.join(";\n")};`);
}
for (const [template, key] of [[runtime, "RUNTIME_WORKER_DATABASE_URL="], [channel, "CHANNEL_ADAPTER_DATABASE_URL="], [notifier, "ALERT_NOTIFIER_DATABASE_URL="]]) {
  if (!template.includes(key)) throw new Error(`Service template must supply ${key}`);
}
for (const source of ["RUNTIME_WORKER_DATABASE_URL", "CHANNEL_ADAPTER_DATABASE_URL", "ALERT_NOTIFIER_DATABASE_URL"]) {
  if (!compose.includes(source)) throw new Error(`Runtime Compose must inject ${source} into its matching service`);
}

console.log("PASS  runtime worker, channel adapter, alert notifier, and isolated backup principal retain their required database privileges");
