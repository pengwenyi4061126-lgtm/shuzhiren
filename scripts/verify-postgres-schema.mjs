import { readdir } from "node:fs/promises";
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

const requiredTables = ["tenants", "users", "memberships", "products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "outbox_events", "show_revision_segments", "media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "model_releases", "show_revision_model_releases"];
const requiredColumns = { model_releases: ["evidence_ref", "validation_summary"], channel_connections: ["verification_evidence_ref", "verified_by"] };
const rlsTables = new Set(["products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "outbox_events", "show_revision_segments", "media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "model_releases", "show_revision_model_releases"]);
const requiredPolicies = ["tenant_isolation_products", "tenant_isolation_product_versions", "tenant_isolation_shows", "tenant_isolation_show_revisions", "tenant_isolation_live_runs", "tenant_isolation_live_commands", "tenant_isolation_preflight_checks", "tenant_isolation_show_revision_product_versions", "tenant_isolation_audit_events", "tenant_isolation_outbox_events", "tenant_isolation_show_revision_segments", "tenant_isolation_media_assets", "tenant_isolation_channel_connections", "tenant_isolation_runtime_health_samples", "tenant_isolation_runtime_alerts", "tenant_isolation_live_interactions", "tenant_isolation_model_releases", "tenant_isolation_show_revision_model_releases"];
const requiredTriggers = ["audit_events_append_only"];
const expectedMigrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
const errors = [];

const client = new Client({ connectionString: databaseUrl });
let connected = false;
try {
  await client.connect();
  connected = true;
  const applied = new Set((await client.query("select name from schema_migrations")).rows.map((row) => row.name));
  for (const migration of expectedMigrations) if (!applied.has(migration)) errors.push(`未应用迁移：${migration}`);

  const tables = new Map((await client.query("select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")).rows.map((row) => [row.relname, row]));
  for (const table of requiredTables) {
    const row = tables.get(table);
    if (!row) errors.push(`缺少关键表：${table}`);
    else if (rlsTables.has(table) && !row.relrowsecurity) errors.push(`关键表未启用 RLS：${table}`);
  }

  const columns = new Set((await client.query("select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'")).rows.map((row) => row.name));
  for (const [table, names] of Object.entries(requiredColumns)) for (const name of names) if (!columns.has(`${table}.${name}`)) errors.push(`缺少关键列：${table}.${name}`);

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
