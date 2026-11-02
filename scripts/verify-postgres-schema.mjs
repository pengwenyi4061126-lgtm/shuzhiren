import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "infra", "postgres", "migrations");
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const databaseUrl = option("--database-url") ?? process.env.DATABASE_URL;
const allowPrivileged = process.argv.includes("--allow-privileged");
if (!databaseUrl) {
  console.error("ERROR DATABASE_URL or --database-url is required");
  process.exit(1);
}

const requiredTables = ["tenants", "users", "memberships", "products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "outbox_events", "show_revision_segments", "media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "model_releases", "show_revision_model_releases", "commerce_events", "channel_webhook_replays"];
const requiredColumns = { live_runs: ["scheduled_start_event_id"], model_releases: ["evidence_ref", "validation_summary"], channel_connections: ["verification_evidence_ref", "verified_by"], live_interactions: ["external_event_id"], channel_webhook_replays: ["lease_expires_at"], runtime_alerts: ["acknowledged_at", "acknowledged_by"] };
const requiredIndexes = ["live_interactions_external_event_id_idx", "commerce_events_run_occurred_idx", "commerce_events_run_type_idx", "channel_webhook_replays_lease_idx", "runtime_alerts_tenant_acknowledged_idx"];
const rlsTables = new Set(["products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "outbox_events", "show_revision_segments", "media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "model_releases", "show_revision_model_releases", "commerce_events", "channel_webhook_replays"]);
const requiredPolicies = ["tenant_isolation_products", "tenant_isolation_product_versions", "tenant_isolation_shows", "tenant_isolation_show_revisions", "tenant_isolation_live_runs", "tenant_isolation_live_commands", "tenant_isolation_preflight_checks", "tenant_isolation_show_revision_product_versions", "tenant_isolation_audit_events", "tenant_isolation_outbox_events", "tenant_isolation_show_revision_segments", "tenant_isolation_media_assets", "tenant_isolation_channel_connections", "tenant_isolation_runtime_health_samples", "tenant_isolation_runtime_alerts", "tenant_isolation_live_interactions", "tenant_isolation_model_releases", "tenant_isolation_show_revision_model_releases", "tenant_isolation_commerce_events", "tenant_isolation_channel_webhook_replays"];
const requiredTriggers = ["audit_events_append_only"];
const expectedMigrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
const errors = [];

const client = new Client({ connectionString: databaseUrl });
let connected = false;
const rlsProbeRole = `shuzhiren_rls_probe_${process.pid}`;
const rlsProbeTenantA = randomUUID();
const rlsProbeTenantB = randomUUID();
const rlsProbeProductA = randomUUID();
const rlsProbeProductB = randomUUID();
const rlsProbeShowA = randomUUID();
const rlsProbeShowB = randomUUID();
const rlsProbeRevisionA = randomUUID();
const rlsProbeRevisionB = randomUUID();
const rlsProbeRunA = randomUUID();
const rlsProbeRunB = randomUUID();
const rlsProbeChannelA = randomUUID();
const rlsProbeChannelB = randomUUID();
const rlsProbeCommerceA = randomUUID();
const rlsProbeCommerceB = randomUUID();
try {
  await client.connect();
  connected = true;
  const applied = new Set((await client.query("select name from schema_migrations")).rows.map((row) => row.name));
  for (const migration of expectedMigrations) if (!applied.has(migration)) errors.push(`未应用迁移：${migration}`);

  const tables = new Map((await client.query("select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")).rows.map((row) => [row.relname, row]));
  for (const table of requiredTables) {
    const row = tables.get(table);
    if (!row) errors.push(`缺少关键表：${table}`);
    else if (rlsTables.has(table) && !row.relrowsecurity) errors.push(`关键表未启用 RLS：${table}`);
    else if (rlsTables.has(table) && !row.relforcerowsecurity) errors.push(`关键表未强制 RLS：${table}`);
  }

  const columns = new Set((await client.query("select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'")).rows.map((row) => row.name));
  for (const [table, names] of Object.entries(requiredColumns)) for (const name of names) if (!columns.has(`${table}.${name}`)) errors.push(`缺少关键列：${table}.${name}`);

  const indexes = new Set((await client.query("select indexname from pg_indexes where schemaname = 'public'")).rows.map((row) => row.indexname));
  for (const index of requiredIndexes) if (!indexes.has(index)) errors.push(`缺少关键索引：${index}`);

  const policies = new Set((await client.query("select policyname from pg_policies where schemaname = 'public'")).rows.map((row) => row.policyname));
  for (const policy of requiredPolicies) if (!policies.has(policy)) errors.push(`缺少租户隔离策略：${policy}`);

  const triggers = new Set((await client.query("select tgname from pg_trigger where not tgisinternal")).rows.map((row) => row.tgname));
  for (const trigger of requiredTriggers) if (!triggers.has(trigger)) errors.push(`缺少关键触发器：${trigger}`);

  const extension = await client.query("select exists(select 1 from pg_extension where extname = 'pgcrypto') as installed");
  if (!extension.rows[0].installed) errors.push("缺少 pgcrypto 扩展");

  const identity = await client.query("select current_user as role, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user");
  if (!allowPrivileged && (identity.rows[0]?.rolsuper || identity.rows[0]?.rolbypassrls)) errors.push(`应用数据库账号 ${identity.rows[0]?.role ?? "unknown"} 可绕过 RLS；请使用非超级、非 BYPASSRLS 的运行时账号`);

  await client.query("begin");
  try {
    await client.query("select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)");
    const tenantContext = await client.query("select current_setting('app.tenant_id', true) as tenant_id");
    if (tenantContext.rows[0]?.tenant_id !== "00000000-0000-0000-0000-000000000000") errors.push("无法设置数据库租户上下文");
  } finally {
    await client.query("rollback");
  }

  if (allowPrivileged) {
    await verifyRlsPolicyWithUnprivilegedRole();
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : "数据库结构检查失败");
} finally {
  if (connected) await client.end();
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  PostgreSQL 架构、迁移、RLS 与租户上下文检查通过（${expectedMigrations.length} 项迁移）`);
}

async function verifyRlsPolicyWithUnprivilegedRole() {
  const role = `"${rlsProbeRole.replaceAll('"', '""')}"`;
  try {
    await client.query(`create role ${role} nologin`);
    await client.query(`grant usage on schema public to ${role}`);
    await client.query(`grant select on products, commerce_events to ${role}`);
    await client.query("insert into tenants (id, slug, name) values ($1, $2, $3), ($4, $5, $6)", [rlsProbeTenantA, `rls-probe-a-${rlsProbeTenantA}`, "RLS probe A", rlsProbeTenantB, `rls-probe-b-${rlsProbeTenantB}`, "RLS probe B"]);
    await client.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, $4), ($5, $6, $7, $8)", [rlsProbeProductA, rlsProbeTenantA, "rls-probe-a", "RLS probe A", rlsProbeProductB, rlsProbeTenantB, "rls-probe-b", "RLS probe B"]);
    await client.query("insert into shows (id, tenant_id, name) values ($1, $2, 'RLS commerce A'), ($3, $4, 'RLS commerce B')", [rlsProbeShowA, rlsProbeTenantA, rlsProbeShowB, rlsProbeTenantB]);
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'approved'), ($4, $5, $6, 1, '{}'::jsonb, 'approved')", [rlsProbeRevisionA, rlsProbeTenantA, rlsProbeShowA, rlsProbeRevisionB, rlsProbeTenantB, rlsProbeShowB]);
    await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, 'RLS channel A', 'generic-rtmp', 'connected', 'rtmp', 'secret://rls/a', '{}'::jsonb), ($3, $4, 'RLS channel B', 'generic-rtmp', 'connected', 'rtmp', 'secret://rls/b', '{}'::jsonb)", [rlsProbeChannelA, rlsProbeTenantA, rlsProbeChannelB, rlsProbeTenantB]);
    await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id, channel_connection_id) values ($1, $2, $3, 'ENDED', $4, $5), ($6, $7, $8, 'ENDED', $9, $10)", [rlsProbeRunA, rlsProbeTenantA, rlsProbeRevisionA, `rls-commerce-a-${rlsProbeRunA}`, rlsProbeChannelA, rlsProbeRunB, rlsProbeTenantB, rlsProbeRevisionB, `rls-commerce-b-${rlsProbeRunB}`, rlsProbeChannelB]);
    await client.query("insert into commerce_events (id, tenant_id, live_run_id, channel_connection_id, external_event_id, event_type, amount_cents) values ($1, $2, $3, $4, 'rls-commerce-a', 'order_paid', 100), ($5, $6, $7, $8, 'rls-commerce-b', 'order_paid', 200)", [rlsProbeCommerceA, rlsProbeTenantA, rlsProbeRunA, rlsProbeChannelA, rlsProbeCommerceB, rlsProbeTenantB, rlsProbeRunB, rlsProbeChannelB]);

    await client.query("begin");
    try {
      await client.query(`set local role ${role}`);
      await client.query("select set_config('app.tenant_id', $1, true)", [rlsProbeTenantA]);
      const visible = await client.query("select id from products order by id");
      if (visible.rows.length !== 1 || visible.rows[0]?.id !== rlsProbeProductA) errors.push("RLS 策略未隔离非特权账号的跨租户产品记录");
      const commerce = await client.query("select id, amount_cents from commerce_events order by id");
      if (commerce.rows.length !== 1 || commerce.rows[0]?.id !== rlsProbeCommerceA || Number(commerce.rows[0]?.amount_cents) !== 100) errors.push("RLS 策略未隔离非特权账号的跨租户交易记录");
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.query("delete from commerce_events where id in ($1, $2)", [rlsProbeCommerceA, rlsProbeCommerceB]).catch(() => undefined);
    await client.query("delete from live_runs where id in ($1, $2)", [rlsProbeRunA, rlsProbeRunB]).catch(() => undefined);
    await client.query("delete from channel_connections where id in ($1, $2)", [rlsProbeChannelA, rlsProbeChannelB]).catch(() => undefined);
    await client.query("delete from show_revisions where id in ($1, $2)", [rlsProbeRevisionA, rlsProbeRevisionB]).catch(() => undefined);
    await client.query("delete from shows where id in ($1, $2)", [rlsProbeShowA, rlsProbeShowB]).catch(() => undefined);
    await client.query("delete from products where id in ($1, $2)", [rlsProbeProductA, rlsProbeProductB]).catch(() => undefined);
    await client.query("delete from tenants where id in ($1, $2)", [rlsProbeTenantA, rlsProbeTenantB]).catch(() => undefined);
    await client.query(`drop role if exists ${role}`).catch(() => undefined);
  }
}
