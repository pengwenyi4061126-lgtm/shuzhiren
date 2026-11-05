import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations } from "../apps/console/scripts/migration-integrity.mjs";
import { substitutePsqlIdentifierVariable } from "./lib/sql-lexer.mjs";

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

const requiredTables = ["schema_migrations", "tenants", "users", "memberships", "products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "audit_chain_heads", "outbox_events", "show_revision_segments", "media_assets", "show_revision_media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "program_output_observations", "live_interactions", "channel_reply_drafts", "model_releases", "show_revision_model_releases", "commerce_events", "channel_webhook_replays", "alert_notification_deliveries", "incidents", "tenant_entitlements", "usage_records", "policy_profiles", "show_revision_policy_profiles", "show_revision_release_manifest_snapshots", "show_program_change_requests", "recording_evidence"];
const requiredColumns = { schema_migrations: ["name", "checksum", "applied_at"], memberships: ["id", "status", "updated_at", "suspended_at", "revoked_at"], live_runs: ["scheduled_start_event_id", "pending_media_event_id", "active_program_segment_id", "active_insert_source_segment_id", "active_insert_program_segment_id", "pending_program_transition_event_id"], show_revisions: ["approved_by", "approved_at"], show_revision_segments: ["runtime_script"], show_program_change_requests: ["status", "candidate_revision_id", "proposed_program_sha256", "approved_by", "applied_at"], audit_events: ["chain_sequence", "previous_hash", "event_hash"], media_assets: ["approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason", "runtime_voice_id", "verified_object_version", "verified_bytes", "verified_content_type", "verification_evidence_ref", "verified_at"], recording_evidence: ["verified_object_version", "verification_evidence_ref", "verified_at"], model_releases: ["evidence_ref", "validation_summary", "approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason"], channel_connections: ["verification_evidence_ref", "verified_by"], runtime_health_samples: ["audio_active"], program_output_observations: ["outbox_event_id", "runtime_session_id", "command_id", "program_segment_id", "control_action", "evidence_ref", "content_sha256", "confidence", "media_time_ms", "observed_at", "verifier_issuer", "verifier_key_id", "attested_at", "attestation_expires_at", "attestation_sha256"], live_interactions: ["external_event_id", "channel_connection_id"], channel_reply_drafts: ["body_sha256", "channel_connection_id", "approved_by", "approved_at", "outbox_event_id"], channel_webhook_replays: ["lease_expires_at"], runtime_alerts: ["acknowledged_at", "acknowledged_by"], policy_profiles: ["approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason"], commerce_events: ["quantity"] };
const requiredIndexes = ["memberships_id_idx", "memberships_tenant_active_role_idx", "live_runs_pending_media_event_id_key", "live_runs_pending_program_transition_event_id_key", "show_revision_segments_runtime_script_idx", "program_output_observations_run_observed_idx", "live_interactions_external_event_id_idx", "commerce_events_run_occurred_idx", "commerce_events_run_type_idx", "channel_webhook_replays_lease_idx", "runtime_alerts_tenant_acknowledged_idx", "runtime_alerts_one_open_condition_key", "alert_notification_deliveries_claim_idx", "incidents_tenant_status_opened_idx", "audit_events_tenant_chain_sequence_idx", "usage_records_tenant_code_occurred_idx", "media_assets_tenant_revoked_idx", "media_assets_tenant_verification_idx", "recording_evidence_tenant_verification_idx", "show_revision_media_assets_tenant_revision_idx", "model_releases_tenant_revoked_idx", "policy_profiles_tenant_approval_idx", "policy_profiles_tenant_revoked_idx", "show_revision_policy_profiles_tenant_revision_idx", "show_revision_release_manifest_snapshots_tenant_revision_idx", "show_program_change_requests_one_active_run_idx", "show_program_change_requests_tenant_run_idx"];
const requiredPolicies = ["tenant_isolation_memberships", "tenant_isolation_products", "tenant_isolation_product_versions", "tenant_isolation_shows", "tenant_isolation_show_revisions", "tenant_isolation_live_runs", "tenant_isolation_live_commands", "tenant_isolation_preflight_checks", "tenant_isolation_show_revision_product_versions", "tenant_isolation_audit_events", "tenant_isolation_audit_chain_heads", "tenant_isolation_outbox_events", "tenant_isolation_show_revision_segments", "tenant_isolation_media_assets", "tenant_isolation_show_revision_media_assets", "tenant_isolation_channel_connections", "tenant_isolation_runtime_health_samples", "tenant_isolation_runtime_alerts", "tenant_isolation_program_output_observations", "tenant_isolation_live_interactions", "tenant_isolation_channel_reply_drafts", "tenant_isolation_model_releases", "tenant_isolation_show_revision_model_releases", "tenant_isolation_commerce_events", "tenant_isolation_channel_webhook_replays", "tenant_isolation_alert_notification_deliveries", "tenant_isolation_incidents", "tenant_isolation_tenant_entitlements", "tenant_isolation_usage_records", "tenant_isolation_policy_profiles", "tenant_isolation_show_revision_policy_profiles", "tenant_isolation_show_revision_release_manifest_snapshots", "tenant_isolation_show_program_change_requests", "tenant_isolation_recording_evidence"];
requiredTables.push("membership_resource_scopes");
requiredColumns.memberships.push("access_scope");
requiredColumns.membership_resource_scopes = ["membership_id", "resource_type", "resource_id"];
requiredIndexes.push("membership_resource_scopes_membership_idx", "membership_resource_scopes_tenant_resource_idx");
requiredPolicies.push("tenant_isolation_membership_resource_scopes");
requiredTables.push("settlement_batches", "settlement_lines", "settlement_reconciliation_exceptions");
requiredColumns.settlement_batches = ["source_sha256", "evidence_ref", "status", "imported_by"];
requiredColumns.settlement_lines = ["external_line_id", "line_type", "amount_cents"];
requiredColumns.settlement_reconciliation_exceptions = ["exception_type", "status", "resolution_evidence_ref", "resolved_by"];
requiredIndexes.push("settlement_batches_tenant_imported_idx", "settlement_lines_batch_type_idx", "settlement_exceptions_batch_status_idx");
requiredPolicies.push("tenant_isolation_settlement_batches", "tenant_isolation_settlement_lines", "tenant_isolation_settlement_reconciliation_exceptions");
const requiredTriggers = ["audit_events_append_only", "audit_events_hash_chain", "usage_records_append_only", "show_revision_product_versions_immutable", "show_revision_segments_immutable", "show_revision_model_releases_immutable", "show_revision_policy_profiles_immutable", "show_revision_media_assets_immutable", "show_revision_release_manifest_snapshots_append_only", "product_versions_governed_immutable", "show_revisions_append_only", "policy_profiles_governed_immutable", "model_releases_governed_immutable", "live_commands_append_only", "media_assets_governed_evidence_mutation", "recording_evidence_governed_mutation", "program_output_observations_append_only", "channel_connections_governed_verification", "channel_reply_drafts_governed_mutation", "settlement_batches_governed_mutation", "settlement_lines_governed_mutation", "settlement_exceptions_governed_mutation", "show_program_change_requests_governed_mutation", "live_runs_governed_show_revision_rebind", "show_revisions_require_runtime_scripts_for_approval", "show_program_change_requests_require_runtime_scripts", "live_runs_governed_program_cursor"];
requiredTriggers.push("audit_chain_heads_guard", "audit_chain_heads_no_truncate");
requiredTriggers.push("outbox_events_media_dispatch_sequence");
requiredIndexes.push("outbox_events_media_aggregate_order_idx");
// H7 (080): the runtime worker flags events the Gateway answered with command_outcome_uncertain.
requiredColumns.outbox_events = ["outcome_uncertain_at"];
requiredTriggers.push("product_versions_approved_insert_evidence", "show_revisions_approved_insert_evidence", "media_assets_approved_insert_evidence", "model_releases_approved_insert_evidence", "policy_profiles_approved_insert_evidence");
// Functions that must run as their owner so callers need no write privilege on the tables they maintain.
const requiredSecurityDefinerFunctions = ["seal_audit_event", "protect_last_active_tenant_admin"];
requiredTables.push("membership_admin_guards");
requiredPolicies.push("tenant_isolation_membership_admin_guards");
// 082: platform-wide preset catalogue (no tenant_id, so no tenant RLS); read-only for the control plane.
requiredTables.push("runtime_presets");
requiredColumns.runtime_presets = ["kind", "preset_code", "display_name", "compatible_model_kind", "runtime_ref", "license_name", "license_source_url", "commercial_use_status", "enabled", "created_at"];
const requiredConstraints = new Map([["schema_migrations_checksum_format", true], ["policy_profiles_evidence_ref_format_check", false], ["model_releases_evidence_ref_format_check", false], ["channel_connections_verification_evidence_ref_check", true], ["channel_connections_connected_verification_check", true], ["show_revision_segments_runtime_script_length", true]]);
// RLS coverage comes from the system catalog, not from a hand-written list (M5): every public table with a
// tenant_id column must have both ENABLE and FORCE ROW LEVEL SECURITY. The settlement tables are listed again so
// that losing their tenant_id column or the table itself is reported instead of silently leaving the set.
const mandatoryRlsTables = ["settlement_batches", "settlement_lines", "settlement_reconciliation_exceptions"];
const rlsCatalogSql = `select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
  order by c.relname`;
// The Migrator's own loader computes the checksums, so line endings are normalized the same way (M4).
const migrationFiles = await loadMigrations(migrationsDirectory);
const expectedMigrations = migrationFiles.map((migration) => migration.name);
const expectedMigrationChecksums = new Map(migrationFiles.map((migration) => [migration.name, migration.checksum]));
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
  const applied = new Map((await client.query("select name, checksum from schema_migrations")).rows.map((row) => [row.name, row.checksum]));
  for (const migration of expectedMigrations) {
    const checksum = applied.get(migration);
    if (!checksum) errors.push(`未应用或未校验迁移：${migration}`);
    else if (checksum !== expectedMigrationChecksums.get(migration)) errors.push(`迁移内容哈希不一致：${migration}`);
  }
  for (const migration of applied.keys()) if (!expectedMigrationChecksums.has(migration)) errors.push(`数据库记录了仓库不存在的迁移：${migration}`);

  const tables = new Set((await client.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')")).rows.map((row) => row.relname));
  for (const table of requiredTables) if (!tables.has(table)) errors.push(`缺少关键表：${table}`);
  errors.push(...rlsCoverageErrors((await client.query(rlsCatalogSql)).rows));

  const columns = new Set((await client.query("select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'")).rows.map((row) => row.name));
  for (const [table, names] of Object.entries(requiredColumns)) for (const name of names) if (!columns.has(`${table}.${name}`)) errors.push(`缺少关键列：${table}.${name}`);

  const indexes = new Set((await client.query("select indexname from pg_indexes where schemaname = 'public'")).rows.map((row) => row.indexname));
  for (const index of requiredIndexes) if (!indexes.has(index)) errors.push(`缺少关键索引：${index}`);

  const policies = new Set((await client.query("select policyname from pg_policies where schemaname = 'public'")).rows.map((row) => row.policyname));
  for (const policy of requiredPolicies) if (!policies.has(policy)) errors.push(`缺少租户隔离策略：${policy}`);

  const triggers = new Set((await client.query("select tgname from pg_trigger where not tgisinternal")).rows.map((row) => row.tgname));
  for (const trigger of requiredTriggers) if (!triggers.has(trigger)) errors.push(`缺少关键触发器：${trigger}`);

  // M15: every foreign key between two tenant tables needs a composite (tenant_id, ...) counterpart (078).
  if (!(await client.query("select to_regprocedure('public.tenant_reference_foreign_keys()') is not null as present")).rows[0].present) errors.push("缺少函数：tenant_reference_foreign_keys()");
  else {
    const uncovered = await client.query(`select f.child::text as child, f.constraint_name from tenant_reference_foreign_keys() f
      where not f.tenant_scoped and not exists (
        select 1 from tenant_reference_foreign_keys() g
        where g.tenant_scoped and g.child = f.child and g.parent = f.parent
          and (select array_agg(x order by x) from unnest(g.child_columns) x) = (select array_agg(x order by x) from unnest(array['tenant_id'] || f.child_columns) x))`);
    for (const row of uncovered.rows) errors.push(`外键未校验同租户：${row.child}.${row.constraint_name}`);
  }

  const securityDefiners = new Set((await client.query("select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef")).rows.map((row) => row.proname));
  for (const name of requiredSecurityDefinerFunctions) if (!securityDefiners.has(name)) errors.push(`函数必须为 SECURITY DEFINER：${name}`);

  const constraints = new Map((await client.query("select conname, convalidated from pg_constraint where connamespace = 'public'::regnamespace")).rows.map((row) => [row.conname, row]));
  for (const [constraint, mustValidate] of requiredConstraints) {
    const row = constraints.get(constraint);
    if (!row) errors.push(`缺少关键约束：${constraint}`);
    else if (mustValidate && !row.convalidated) errors.push(`关键约束尚未验证：${constraint}`);
  }

  const extension = await client.query("select exists(select 1 from pg_extension where extname = 'pgcrypto') as installed");
  if (!extension.rows[0].installed) errors.push("缺少 pgcrypto 扩展");

  const outboxStates = new Set((await client.query("select e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname = 'outbox_state'")).rows.map((row) => row.enumlabel));
  for (const state of ["pending", "delivering", "delivered", "failed", "cancelled"]) if (!outboxStates.has(state)) errors.push(`outbox_state 缺少状态：${state}`);

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
  await verifyControlPlanePrincipal(identity.rows[0]?.role);
  await verifyGovernedEvidenceImmutability();
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

function rlsCoverageErrors(catalogRows) {
  if (!catalogRows.length) return ["RLS 校验集合为空：public schema 中未找到任何含 tenant_id 列的表"];
  const result = [];
  const catalogTables = new Set(catalogRows.map((row) => row.table_name));
  for (const table of mandatoryRlsTables) if (!catalogTables.has(table)) result.push(`强制 RLS 表缺失或没有 tenant_id 列：table=${table}`);
  for (const row of catalogRows) {
    const missing = [...(row.rls_enabled ? [] : ["ENABLE"]), ...(row.rls_forced ? [] : ["FORCE"])];
    if (missing.length) result.push(`表未完整启用 RLS：table=${row.table_name} missing=${missing.join(",")}`);
  }
  return result;
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
    // The probe only needs revisions to attach runs to; an approved insert would need approval evidence (075).
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'draft'), ($4, $5, $6, 1, '{}'::jsonb, 'draft')", [rlsProbeRevisionA, rlsProbeTenantA, rlsProbeShowA, rlsProbeRevisionB, rlsProbeTenantB, rlsProbeShowB]);
    await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, 'RLS channel A', 'generic-rtmp', 'disabled', 'rtmp', 'secret://rls/a', '{}'::jsonb), ($3, $4, 'RLS channel B', 'generic-rtmp', 'disabled', 'rtmp', 'secret://rls/b', '{}'::jsonb)", [rlsProbeChannelA, rlsProbeTenantA, rlsProbeChannelB, rlsProbeTenantB]);
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
    // The grants above would make a plain drop role fail and leave the role behind for a later run to collide with.
    await client.query(`revoke all on products, commerce_events from ${role}`).catch(() => undefined);
    await client.query(`revoke usage on schema public from ${role}`).catch(() => undefined);
    await client.query(`drop role if exists ${role}`).catch(() => undefined);
  }
}

async function verifyGovernedEvidenceImmutability() {
  const tenantId = randomUUID();
  const productId = randomUUID();
  const productVersionId = randomUUID();
  const showId = randomUUID();
  const revisionId = randomUUID();
  const draftRevisionId = randomUUID();
  const candidateRevisionId = randomUUID();
  const changeRequestId = randomUUID();
  const policyProfileId = randomUUID();
  const releaseId = randomUUID();
  const assetId = randomUUID();
  const recordingId = randomUUID();
  const runId = randomUUID();
  const draftRunId = randomUUID();
  const commandId = randomUUID();
  const channelId = randomUUID();
  const interactionId = randomUUID();
  const replyId = randomUUID();
  const replyOutboxId = randomUUID();
  const settlementBatchId = randomUUID();
  const settlementLineId = randomUUID();
  const settlementExceptionId = randomUUID();

  await client.query("begin");
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Governed evidence verifier')", [tenantId, `governed-evidence-${tenantId}`]);
    const actor = await client.query("insert into users (external_subject, display_name) values ($1, 'Governed evidence verifier') returning id", [`governed-evidence-${tenantId}`]);
    const actorId = actor.rows[0].id;
    await client.query("insert into memberships (tenant_id, user_id, role) values ($1, $2, 'reviewer')", [tenantId, actorId]);
    const outsider = await client.query("insert into users (external_subject, display_name) values ($1, 'Governed evidence outsider') returning id", [`governed-evidence-outsider-${tenantId}`]);
    const outsiderId = outsider.rows[0].id;

    await client.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, 'governed-evidence-sku', 'Governed evidence product')", [productId, tenantId]);
    await client.query("insert into product_versions (id, tenant_id, product_id, revision, facts, approval_status) values ($1, $2, $3, 1, $4::jsonb, 'draft')", [productVersionId, tenantId, productId, JSON.stringify({ priceCent: 100, stock: 1 })]);
    await client.query("update product_versions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [productVersionId, actorId]);
    await expectImmutableRejection("update product_versions set facts = $2::jsonb where id = $1", [productVersionId, JSON.stringify({ priceCent: 1, stock: 999 })], "已批准商品事实不得改写");

    await client.query("insert into shows (id, tenant_id, name) values ($1, $2, 'Governed evidence show')", [showId, tenantId]);
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'draft')", [revisionId, tenantId, showId]);
    await client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, actorId]);
    await expectImmutableRejection("update show_revisions set plan = '{\"changed\":true}'::jsonb where id = $1", [revisionId], "节目修订不得改写");
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 2, '{}'::jsonb, 'draft')", [draftRevisionId, tenantId, showId]);
    await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id) values ($1, $2, $3, 'DRAFT', $4)", [draftRunId, tenantId, draftRevisionId, `governed-draft-${draftRunId}`]);
    await client.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, purpose, is_fallback) values ($1, $2, 1, 'fallback', 'Draft fallback', 30, 'Draft edit verifier', true)", [tenantId, draftRevisionId]);
    await client.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, purpose, is_fallback) values ($1, $2, 2, 'prepared_product', 'Draft runnable', 30, 'Runtime script gate verifier', false)", [tenantId, draftRevisionId]);
    await expectImmutableRejection("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [draftRevisionId, actorId], "缺少冻结脚本的可运行节目不得批准");
    await client.query("update show_revision_segments set title = 'Draft fallback edited' where show_revision_id = $1", [draftRevisionId]);
    await client.query("update live_runs set state = 'REVIEW' where id = $1", [draftRunId]);
    await expectImmutableRejection("update show_revision_segments set title = 'Illegal review edit' where show_revision_id = $1", [draftRevisionId], "审核后节目段落不得改写");

    await client.query("insert into policy_profiles (id, tenant_id, name, version, rules, evidence_ref, validation_summary) values ($1, $2, 'Governed evidence policy', '1.0.0', '[]'::jsonb, 'evidence://governed-policy', 'Governed verifier policy')", [policyProfileId, tenantId]);
    await client.query("update policy_profiles set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [policyProfileId, actorId]);
    await expectImmutableRejection("update policy_profiles set rules = '[{\"id\":\"mutated\"}]'::jsonb where id = $1", [policyProfileId], "已批准策略不得改写");
    await client.query("update policy_profiles set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = 'governed verifier' where id = $1", [policyProfileId, actorId]);

    await client.query("insert into model_releases (id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, approval_status) values ($1, $2, 'Governed evidence release', '1.0.0', 'runtime', '1234567', 'sha256:governed-image', 'sha256:governed-artifact', 'governed-driver', 'Apache-2.0', 'governed scope', 'evidence://governed-release', 'Governed verifier release', 'pending')", [releaseId, tenantId]);
    await client.query("update model_releases set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [releaseId, actorId]);
    await expectImmutableRejection("update model_releases set artifact_hash = 'sha256:mutated' where id = $1", [releaseId], "已批准发布包不得改写");
    await client.query("update model_releases set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = 'governed verifier' where id = $1", [releaseId, actorId]);

    await client.query("insert into media_assets (id, tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status) values ($1, $2, 'music', 'Governed evidence media', 'assets/governed/music.mp3', 'sha256:governed-media', 'governed scope', 'evidence://governed-media', 'pending')", [assetId, tenantId]);
    await expectImmutableRejection("update media_assets set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [assetId, actorId], "未验证素材不得批准");
    await client.query("update media_assets set approval_status = 'approved', approved_by = $2, approved_at = now(), verified_object_version = 'governed-v1', verified_bytes = 1024, verified_content_type = 'audio/mpeg', verification_evidence_ref = 'evidence://governed-media-content', verified_at = now() where id = $1", [assetId, actorId]);
    await expectImmutableRejection("update media_assets set checksum = 'sha256:mutated-media' where id = $1", [assetId], "已批准素材内容摘要不得改写");

    await client.query("insert into live_runs (id, tenant_id, show_revision_id, state, trace_id) values ($1, $2, $3, 'DRAFT', $4)", [runId, tenantId, revisionId, `governed-evidence-${runId}`]);
    await expectImmutableRejection("insert into recording_evidence (tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, idempotency_key) values ($1, $2, 'recordings/governed/absent-attestation.mp4', repeat('a', 64), 1024, 10, 'governed-recording-absent')", [tenantId, runId], "缺少 verifier 回执的录制证据不得登记");
    await client.query("insert into recording_evidence (id, tenant_id, live_run_id, object_key, checksum_sha256, bytes, duration_seconds, idempotency_key, verified_object_version, verification_evidence_ref, verified_at) values ($1, $2, $3, 'recordings/governed/verified.mp4', repeat('a', 64), 1024, 10, 'governed-recording-verified', 'governed-recording-v1', 'evidence://governed/recording', now())", [recordingId, tenantId, runId]);
    await expectImmutableRejection("update recording_evidence set verification_evidence_ref = 'evidence://governed/recording-mutated' where id = $1", [recordingId], "已登记录制验证证据不得改写");
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 3, '{}'::jsonb, 'draft')", [candidateRevisionId, tenantId, showId]);
    await client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, candidateRevisionId, productVersionId]);
    await client.query("insert into show_program_change_requests (id, tenant_id, live_run_id, source_revision_id, candidate_revision_id, source_program_sha256, created_by) values ($1, $2, $3, $4, $5, repeat('a', 64), $6)", [changeRequestId, tenantId, runId, revisionId, candidateRevisionId, actorId]);
    await expectImmutableRejection("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'late-binding')", [tenantId, candidateRevisionId, productVersionId], "候选节目依赖绑定不得改写");
    await client.query("insert into live_commands (id, tenant_id, live_run_id, actor_id, idempotency_key, expected_state, action, result) values ($1, $2, $3, $4, 'governed-evidence-command', 'DRAFT', 'START', '{}'::jsonb)", [commandId, tenantId, runId, actorId]);
    await expectImmutableRejection("update live_commands set result = '{\"mutated\":true}'::jsonb where id = $1", [commandId], "直播命令不得改写");

    await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, 'Governed evidence channel', 'normalized-webhook-rtmp', 'disabled', 'rtmp', 'kms://governed/channel', $3::jsonb)", [channelId, tenantId, JSON.stringify({ supportsOutboundReplies: true })]);
    await expectImmutableRejection("update channel_connections set status = 'connected' where id = $1", [channelId], "无验证证据的渠道不得启用");
    await client.query("update channel_connections set status = 'connected', last_verified_at = now(), verification_evidence_ref = 'evidence://governed/channel-verification', verified_by = $2 where id = $1", [channelId, actorId]);
    await expectImmutableRejection("update channel_connections set verified_by = $2 where id = $1", [channelId, outsiderId], "非租户成员不得作为渠道验证人");
    await expectImmutableRejection("update channel_connections set secret_ref = 'kms://governed/channel-mutated' where id = $1", [channelId], "渠道密钥引用不得改写");
    await client.query("insert into settlement_batches (id, tenant_id, channel_connection_id, provider_statement_ref, period_start, period_end, source_sha256, evidence_ref, imported_by) values ($1, $2, $3, 'governed-statement', now() - interval '1 day', now(), repeat('a', 64), 'evidence://governed/settlement', $4)", [settlementBatchId, tenantId, channelId, actorId]);
    await client.query("insert into settlement_lines (id, tenant_id, settlement_batch_id, external_line_id, line_type, external_order_reference, occurred_at, amount_cents) values ($1, $2, $3, 'governed-line', 'gross_sale', 'governed-order', now(), 100)", [settlementLineId, tenantId, settlementBatchId]);
    await expectImmutableRejection("update settlement_batches set source_sha256 = repeat('b', 64) where id = $1", [settlementBatchId], "结算账单来源不得改写");
    await expectImmutableRejection("update settlement_lines set amount_cents = 1 where id = $1", [settlementLineId], "结算账单行不得改写");
    await client.query("insert into settlement_reconciliation_exceptions (id, tenant_id, settlement_batch_id, settlement_line_id, order_reference, exception_type, actual_amount_cents, detail) values ($1, $2, $3, $4, 'governed-order', 'missing_operational_event', 100, 'Governed settlement exception')", [settlementExceptionId, tenantId, settlementBatchId, settlementLineId]);
    await expectImmutableRejection("update settlement_reconciliation_exceptions set detail = 'mutated' where id = $1", [settlementExceptionId], "结算差异事实不得改写");
    await client.query("update settlement_reconciliation_exceptions set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = 'Governed settlement resolution', resolution_evidence_ref = 'evidence://governed/settlement-resolution' where id = $1", [settlementExceptionId, actorId]);
    await expectImmutableRejection("update settlement_reconciliation_exceptions set resolution = 'Mutated settlement resolution' where id = $1", [settlementExceptionId], "已结案结算差异不得改写");
    await client.query("insert into live_interactions (id, tenant_id, live_run_id, source, channel_connection_id, question_text, risk_level, policy_action, evidence_ids) values ($1, $2, $3, 'channel:governed', $4, 'Can this be sent?', 'low', 'answer', '[\"product_version\"]'::jsonb)", [interactionId, tenantId, runId, channelId]);
    await client.query("insert into channel_reply_drafts (id, tenant_id, live_run_id, interaction_id, channel_connection_id, body, body_sha256, policy_action, evidence_snapshot, created_by) values ($1, $2, $3, $4, $5, 'Initial governed reply', encode(digest('Initial governed reply', 'sha256'), 'hex'), 'answer', '[{\"type\":\"product_version\",\"id\":\"evidence\"}]'::jsonb, $6)", [replyId, tenantId, runId, interactionId, channelId, actorId]);
    await client.query("update channel_reply_drafts set body = 'Edited governed reply', body_sha256 = encode(digest('Edited governed reply', 'sha256'), 'hex'), edited_by = $2 where id = $1", [replyId, actorId]);
    await client.query("update channel_reply_drafts set status = 'pending_approval', submitted_at = now() where id = $1", [replyId]);
    await expectImmutableRejection("update channel_reply_drafts set body = 'Illegal post-submit reply mutation', body_sha256 = encode(digest('Illegal post-submit reply mutation', 'sha256'), 'hex') where id = $1", [replyId], "送审后的渠道回复正文不得改写");
    await client.query("update channel_reply_drafts set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [replyId, actorId]);
    await client.query("insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, 'channel.reply.dispatch', 'channel_reply_draft', $3, '{}'::jsonb)", [replyOutboxId, tenantId, replyId]);
    await client.query("update channel_reply_drafts set status = 'sending', outbox_event_id = $2 where id = $1", [replyId, replyOutboxId]);
    await expectImmutableRejection("update channel_reply_drafts set channel_connection_id = $2 where id = $1", [replyId, channelId], "投递中的渠道回复不得改写目标渠道");

    // M13: a row inserted directly as approved must carry its approval evidence (075).
    const approvedInserts = [
      { table: "product_versions", evidence: ["approved_by", "approved_at"], row: (n) => ({ id: randomUUID(), tenant_id: tenantId, product_id: productId, revision: 100 + n, facts: JSON.stringify({ priceCent: 100, stock: 1 }) }) },
      { table: "show_revisions", evidence: ["approved_by", "approved_at"], row: (n) => ({ id: randomUUID(), tenant_id: tenantId, show_id: showId, revision: 100 + n, plan: "{}" }) },
      { table: "media_assets", evidence: ["approved_by", "approved_at", "verified_object_version", "verified_bytes", "verified_content_type", "verification_evidence_ref", "verified_at"], row: (n) => ({ id: randomUUID(), tenant_id: tenantId, kind: "music", name: `Approved insert media ${n}`, object_key: `assets/governed/approved-insert-${n}.mp3`, checksum: `sha256:approved-insert-${n}`, rights_scope: "governed scope", source_ref: "evidence://governed-media", verified_object_version: "approved-insert-v1", verified_bytes: 1024, verified_content_type: "audio/mpeg", verification_evidence_ref: "evidence://governed/approved-insert-content", verified_at: new Date() }) },
      { table: "model_releases", evidence: ["approved_by", "approved_at"], row: (n) => ({ id: randomUUID(), tenant_id: tenantId, name: "Approved insert release", version: `approved-insert-${n}`, component: "runtime", source_commit: "1234567", image_digest: "sha256:approved-insert-image", artifact_hash: "sha256:approved-insert-artifact", driver_version: "governed-driver", license: "Apache-2.0", rights_scope: "governed scope", evidence_ref: "evidence://governed-release", validation_summary: "Approved insert release" }) },
      { table: "policy_profiles", evidence: ["approved_by", "approved_at"], row: (n) => ({ id: randomUUID(), tenant_id: tenantId, name: "Approved insert policy", version: `approved-insert-${n}`, rules: "[]", evidence_ref: "evidence://governed-policy", validation_summary: "Approved insert policy" }) }
    ];
    // M15: a row must not reference a row of another tenant, and a referenced row must not move to another tenant (078).
    const otherTenantId = randomUUID();
    const otherShowId = randomUUID();
    const otherRevisionId = randomUUID();
    await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Governed evidence other tenant')", [otherTenantId, `governed-evidence-other-${otherTenantId}`]);
    await client.query("insert into shows (id, tenant_id, name) values ($1, $2, 'Other tenant show')", [otherShowId, otherTenantId]);
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 1, '{}'::jsonb, 'draft')", [otherRevisionId, otherTenantId, otherShowId]);
    await expectForeignKeyRejection("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, 2, '{}'::jsonb, 'draft')", [tenantId, otherShowId], "引用其他租户节目的节目修订");
    await expectForeignKeyRejection("insert into live_runs (tenant_id, show_revision_id, state, trace_id) values ($1, $2, 'DRAFT', $3)", [tenantId, otherRevisionId, `cross-tenant-${randomUUID()}`], "引用其他租户节目修订的场次");
    await expectForeignKeyRejection("update shows set tenant_id = $2 where id = $1", [showId, otherTenantId], "被引用节目改换租户");

    let approvedInsertSequence = 0;
    for (const { table, evidence, row } of approvedInserts) {
      const approved = () => ({ ...row((approvedInsertSequence += 1)), approval_status: "approved", approved_by: actorId, approved_at: new Date() });
      for (const column of evidence) await expectApprovedInsertRejection(table, { ...approved(), [column]: null }, column);
      const accepted = await insertRow(table, approved());
      if (accepted.rowCount !== 1) errors.push(`带完整审批证据的 ${table} 插入未成功`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? `治理证据不可变性检查失败：${error.message}` : "治理证据不可变性检查失败");
  } finally {
    await client.query("rollback");
  }
}

// D4: the control-plane account owns nothing, cannot bypass RLS, cannot write the migration ledger or chain heads,
// and has DML on every other table (from infra/postgres/control-plane-principal.sql). The role checked is
// --control-plane-role when given (a deployment checks its real account, for example as the migration owner with
// --allow-privileged --control-plane-role shuzhiren_control_plane), else the connected account without
// --allow-privileged. With --allow-privileged and no --control-plane-role (CI as superuser), a temporary role
// receives the grants of control-plane-principal.sql in a rolled-back transaction, so the script itself is
// verified against this database whatever roles other tests left in the cluster.
async function verifyControlPlanePrincipal(currentRole) {
  const explicit = option("--control-plane-role");
  const probe = !explicit && allowPrivileged;
  const requested = explicit ?? currentRole;
  if (!probe && (await client.query("select 1 from pg_roles where rolname = $1", [requested])).rowCount !== 1) { errors.push(`控制面数据库账号不存在：${requested}`); return; }
  await client.query("begin");
  try {
    let role = requested;
    if (probe) {
      role = `shuzhiren_control_plane_probe_${process.pid}`;
      await client.query(`create role "${role}" nologin noinherit`);
      const script = await readFile(path.join(root, "infra", "postgres", "control-plane-principal.sql"), "utf8");
      await client.query(substitutePsqlIdentifierVariable(script, "control_plane_role", role));
    }
    const label = probe ? `${role}（按 control-plane-principal.sql 授权的临时账号）` : role;
    const attributes = (await client.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [role])).rows[0];
    if (attributes?.rolsuper || attributes?.rolbypassrls) errors.push(`控制面数据库账号 ${label} 不得具备 SUPERUSER 或 BYPASSRLS`);
    const owned = await client.query(`select c.relname as name from pg_class c where c.relnamespace = 'public'::regnamespace and c.relowner = (select oid from pg_roles where rolname = $1)
      union all select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proowner = (select oid from pg_roles where rolname = $1)
      union all select t.typname from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd') and t.typowner = (select oid from pg_roles where rolname = $1)
      order by 1`, [role]);
    if (owned.rows.length) errors.push(`控制面数据库账号 ${label} 不得是 schema 对象的 owner（D4，应由 shuzhiren_migration_owner 拥有）：${owned.rows.map((row) => row.name).join(", ")}`);
    const privileges = await client.query(`select c.relname as table_name,
        has_table_privilege($1, c.oid, 'select') as can_select, has_table_privilege($1, c.oid, 'insert') as can_insert,
        has_table_privilege($1, c.oid, 'update') as can_update, has_table_privilege($1, c.oid, 'delete') as can_delete,
        has_table_privilege($1, c.oid, 'truncate') as can_truncate
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by c.relname`, [role]);
    const byTable = new Map(privileges.rows.map((row) => [row.table_name, row]));
    for (const table of ["schema_migrations", "audit_chain_heads", "runtime_presets"]) {
      const row = byTable.get(table);
      if (row && (row.can_insert || row.can_update || row.can_delete || row.can_truncate)) errors.push(`控制面数据库账号 ${label} 不得写入 ${table}`);
      if (row && !row.can_select) errors.push(`控制面数据库账号 ${label} 缺少 ${table} 的 SELECT 权限`);
    }
    for (const row of privileges.rows) {
      if (["schema_migrations", "audit_chain_heads", "membership_admin_guards", "runtime_presets"].includes(row.table_name)) continue;
      const missing = ["select", "insert", "update", "delete"].filter((privilege) => !row[`can_${privilege}`]);
      if (missing.length) errors.push(`控制面数据库账号 ${label} 缺少 ${row.table_name} 的 ${missing.join("/").toUpperCase()} 权限（执行 control-plane-principal.sql）`);
      if (row.can_truncate) errors.push(`控制面数据库账号 ${label} 不得 TRUNCATE ${row.table_name}`);
    }
    for (const table of ["channel_connections", "settlement_batches", "settlement_reconciliation_exceptions"]) if (!byTable.has(table)) errors.push(`控制面授权检查缺少表：${table}`);
  } catch (error) {
    errors.push(`控制面数据库账号检查失败：${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await client.query("rollback");
  }
}

async function expectForeignKeyRejection(statement, parameters, label) {
  await client.query("savepoint governed_tenant_reference");
  try {
    await client.query(statement, parameters);
    errors.push(`${label}未被同租户外键拒绝`);
  } catch (error) {
    if (error?.code !== "23503") errors.push(`${label}返回了非预期错误：${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await client.query("rollback to savepoint governed_tenant_reference");
    await client.query("release savepoint governed_tenant_reference");
  }
}

function insertRow(table, row) {
  const columns = Object.keys(row);
  return client.query(`insert into ${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`, columns.map((column) => row[column]));
}

async function expectApprovedInsertRejection(table, row, column) {
  await client.query("savepoint governed_approved_insert");
  try {
    await insertRow(table, row);
    errors.push(`缺少 ${table}.${column} 的已批准插入未被数据库触发器拒绝`);
  } catch (error) {
    if (error?.code !== "23514" || !String(error.message).includes(`approved_insert_requires_evidence: ${table}.${column} must not be null`)) errors.push(`缺少 ${table}.${column} 的已批准插入返回了非预期错误：${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await client.query("rollback to savepoint governed_approved_insert");
    await client.query("release savepoint governed_approved_insert");
  }
}

async function expectImmutableRejection(statement, parameters, label) {
  await client.query("savepoint governed_evidence_mutation");
  try {
    await client.query(statement, parameters);
    errors.push(`${label}未被数据库触发器拒绝`);
  } catch (error) {
    if (!(error instanceof Error) || !/immutable|only permits|editable only|runtime scripts|channel reply|channel connection|channel verification|settlement|recording evidence/i.test(error.message)) errors.push(`${label}返回了非预期错误：${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await client.query("rollback to savepoint governed_evidence_mutation");
    await client.query("release savepoint governed_evidence_mutation");
  }
}
