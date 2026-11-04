import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const principals = ["shuzhiren_runtime_worker", "shuzhiren_channel_adapter", "shuzhiren_alert_notifier"];
const grants = await readFile(new URL("../infra/postgres/service-principals.sql", import.meta.url), "utf8");
const backupGrants = await readFile(new URL("../infra/postgres/backup-principal.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query("begin");
  for (const principal of principals) {
    await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${principal}') then create role ${principal} nologin noinherit; end if; end $$;`);
  }
  await client.query(grants);
  await client.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'shuzhiren_backup') then create role shuzhiren_backup login noinherit bypassrls; end if; end $$;");
  await client.query(backupGrants);

  await expectTable("shuzhiren_channel_adapter", "channel_webhook_replays", "select", true);
  await expectTable("shuzhiren_channel_adapter", "channel_webhook_replays", "update", true);
  await expectTable("shuzhiren_channel_adapter", "live_runs", "select", false);
  await expectTable("shuzhiren_channel_adapter", "audit_events", "insert", false);

  await expectTable("shuzhiren_alert_notifier", "runtime_alerts", "select", true);
  await expectTable("shuzhiren_alert_notifier", "alert_notification_deliveries", "update", true);
  await expectTable("shuzhiren_alert_notifier", "outbox_events", "select", false);

  await expectTable("shuzhiren_runtime_worker", "outbox_events", "update", true);
  await expectTable("shuzhiren_runtime_worker", "show_revision_segments", "select", true);
  await expectTable("shuzhiren_runtime_worker", "audit_events", "insert", true);
  await expectTable("shuzhiren_runtime_worker", "memberships", "select", false);
  await expectTable("shuzhiren_runtime_worker", "users", "update", false);
  const functionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_runtime_worker"]);
  assert.equal(functionPrivilege.rows[0].allowed, true, "runtime worker must record its stable service actor only through runtime_worker_actor");
  const adapterFunctionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_channel_adapter"]);
  assert.equal(adapterFunctionPrivilege.rows[0].allowed, false, "channel adapter must not execute the runtime worker actor function");

  await expectTable("shuzhiren_backup", "audit_events", "select", true);
  await expectTable("shuzhiren_backup", "audit_events", "update", false);
  await expectTable("shuzhiren_backup", "live_runs", "select", true);
  const backupRole = await client.query("select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = 'shuzhiren_backup'");
  assert.deepEqual(backupRole.rows, [{ rolcanlogin: true, rolinherit: false, rolbypassrls: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }], "backup principal must be the isolated LOGIN NOINHERIT BYPASSRLS role required for complete archive reads");
  const backupSchema = await client.query("select has_schema_privilege('shuzhiren_backup', 'public', 'usage') as allowed, has_database_privilege('shuzhiren_backup', current_database(), 'connect') as can_connect");
  assert.deepEqual(backupSchema.rows, [{ allowed: true, can_connect: true }], "backup principal must retain only archive-read connectivity and schema usage");
  const backupMemberships = await client.query("select count(*)::int as count from pg_auth_members membership join pg_roles member_role on member_role.oid = membership.member where member_role.rolname = 'shuzhiren_backup'");
  assert.equal(backupMemberships.rows[0].count, 0, "backup principal must not inherit another role");

  console.log("PASS  database service principals and the isolated backup reader retain only their required privileges");
} finally {
  await client.query("rollback").catch(() => undefined);
  await client.end().catch(() => undefined);
}

async function expectTable(principal, table, privilege, expected) {
  const result = await client.query("select has_table_privilege($1, $2, $3) as allowed", [principal, table, privilege]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} ${privilege} on ${table}`);
}
