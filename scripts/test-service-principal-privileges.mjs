import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const principals = ["shuzhiren_runtime_worker", "shuzhiren_channel_adapter", "shuzhiren_alert_notifier"];
const grants = await readFile(new URL("../infra/postgres/service-principals.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query("begin");
  for (const principal of principals) {
    await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${principal}') then create role ${principal} nologin noinherit; end if; end $$;`);
  }
  await client.query(grants);

  await expectTable("shuzhiren_channel_adapter", "channel_webhook_replays", "select", true);
  await expectTable("shuzhiren_channel_adapter", "channel_webhook_replays", "update", true);
  await expectTable("shuzhiren_channel_adapter", "live_runs", "select", false);
  await expectTable("shuzhiren_channel_adapter", "audit_events", "insert", false);

  await expectTable("shuzhiren_alert_notifier", "runtime_alerts", "select", true);
  await expectTable("shuzhiren_alert_notifier", "alert_notification_deliveries", "update", true);
  await expectTable("shuzhiren_alert_notifier", "outbox_events", "select", false);

  await expectTable("shuzhiren_runtime_worker", "outbox_events", "update", true);
  await expectTable("shuzhiren_runtime_worker", "audit_events", "insert", true);
  await expectTable("shuzhiren_runtime_worker", "memberships", "select", false);
  await expectTable("shuzhiren_runtime_worker", "users", "update", false);
  const functionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_runtime_worker"]);
  assert.equal(functionPrivilege.rows[0].allowed, true, "runtime worker must record its stable service actor only through runtime_worker_actor");
  const adapterFunctionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_channel_adapter"]);
  assert.equal(adapterFunctionPrivilege.rows[0].allowed, false, "channel adapter must not execute the runtime worker actor function");

  console.log("PASS  database service principals retain only their required table and service-actor privileges");
} finally {
  await client.query("rollback").catch(() => undefined);
  await client.end().catch(() => undefined);
}

async function expectTable(principal, table, privilege, expected) {
  const result = await client.query("select has_table_privilege($1, $2, $3) as allowed", [principal, table, privilege]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} ${privilege} on ${table}`);
}
