import { readFile } from "node:fs/promises";

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
  "grant insert on audit_events to shuzhiren_runtime_worker",
  "grant execute on function runtime_worker_actor(uuid, text) to shuzhiren_runtime_worker"
]) if (!grants.includes(source)) throw new Error(`Service principal grants missing: ${source}`);
for (const forbidden of ["grant all", "grant delete", " on memberships to shuzhiren_", " on users to shuzhiren_", " on products to shuzhiren_", " on show_revisions to shuzhiren_", " on audit_chain_heads to shuzhiren_"]) {
  if (grants.toLowerCase().includes(forbidden)) throw new Error(`Service principal grants must not include: ${forbidden}`);
}
for (const [template, key] of [[runtime, "RUNTIME_WORKER_DATABASE_URL="], [channel, "CHANNEL_ADAPTER_DATABASE_URL="], [notifier, "ALERT_NOTIFIER_DATABASE_URL="]]) {
  if (!template.includes(key)) throw new Error(`Service template must supply ${key}`);
}
for (const source of ["RUNTIME_WORKER_DATABASE_URL", "CHANNEL_ADAPTER_DATABASE_URL", "ALERT_NOTIFIER_DATABASE_URL"]) {
  if (!compose.includes(source)) throw new Error(`Runtime Compose must inject ${source} into its matching service`);
}

console.log("PASS  runtime worker, channel adapter, alert notifier, and isolated backup principal retain their required database privileges");
