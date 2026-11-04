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

const requiredTables = ["tenants", "users", "memberships", "products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "audit_chain_heads", "outbox_events", "show_revision_segments", "media_assets", "show_revision_media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "channel_reply_drafts", "model_releases", "show_revision_model_releases", "commerce_events", "channel_webhook_replays", "alert_notification_deliveries", "incidents", "tenant_entitlements", "usage_records", "policy_profiles", "show_revision_policy_profiles", "show_revision_release_manifest_snapshots", "show_program_change_requests"];
const requiredColumns = { memberships: ["id", "status", "updated_at", "suspended_at", "revoked_at"], live_runs: ["scheduled_start_event_id", "pending_media_event_id"], show_revisions: ["approved_by", "approved_at"], show_program_change_requests: ["status", "candidate_revision_id", "proposed_program_sha256", "approved_by", "applied_at"], audit_events: ["chain_sequence", "previous_hash", "event_hash"], media_assets: ["approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason", "runtime_voice_id", "verified_object_version", "verified_bytes", "verified_content_type", "verification_evidence_ref", "verified_at"], model_releases: ["evidence_ref", "validation_summary", "approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason"], channel_connections: ["verification_evidence_ref", "verified_by"], runtime_health_samples: ["audio_active"], live_interactions: ["external_event_id", "channel_connection_id"], channel_reply_drafts: ["body_sha256", "channel_connection_id", "approved_by", "approved_at", "outbox_event_id"], channel_webhook_replays: ["lease_expires_at"], runtime_alerts: ["acknowledged_at", "acknowledged_by"], policy_profiles: ["approved_by", "approved_at", "revoked_by", "revoked_at", "revocation_reason"], commerce_events: ["quantity"] };
const requiredIndexes = ["memberships_id_idx", "memberships_tenant_active_role_idx", "live_runs_pending_media_event_id_key", "live_interactions_external_event_id_idx", "commerce_events_run_occurred_idx", "commerce_events_run_type_idx", "channel_webhook_replays_lease_idx", "runtime_alerts_tenant_acknowledged_idx", "runtime_alerts_one_open_condition_key", "alert_notification_deliveries_claim_idx", "incidents_tenant_status_opened_idx", "audit_events_tenant_chain_sequence_idx", "usage_records_tenant_code_occurred_idx", "media_assets_tenant_revoked_idx", "media_assets_tenant_verification_idx", "show_revision_media_assets_tenant_revision_idx", "model_releases_tenant_revoked_idx", "policy_profiles_tenant_approval_idx", "policy_profiles_tenant_revoked_idx", "show_revision_policy_profiles_tenant_revision_idx", "show_revision_release_manifest_snapshots_tenant_revision_idx", "show_program_change_requests_one_active_run_idx", "show_program_change_requests_tenant_run_idx"];
const rlsTables = new Set(["memberships", "products", "product_versions", "shows", "show_revisions", "live_runs", "live_commands", "preflight_checks", "show_revision_product_versions", "audit_events", "audit_chain_heads", "outbox_events", "show_revision_segments", "media_assets", "show_revision_media_assets", "channel_connections", "runtime_health_samples", "runtime_alerts", "live_interactions", "channel_reply_drafts", "model_releases", "show_revision_model_releases", "commerce_events", "channel_webhook_replays", "alert_notification_deliveries", "incidents", "tenant_entitlements", "usage_records", "policy_profiles", "show_revision_policy_profiles", "show_revision_release_manifest_snapshots", "show_program_change_requests"]);
const requiredPolicies = ["tenant_isolation_memberships", "tenant_isolation_products", "tenant_isolation_product_versions", "tenant_isolation_shows", "tenant_isolation_show_revisions", "tenant_isolation_live_runs", "tenant_isolation_live_commands", "tenant_isolation_preflight_checks", "tenant_isolation_show_revision_product_versions", "tenant_isolation_audit_events", "tenant_isolation_audit_chain_heads", "tenant_isolation_outbox_events", "tenant_isolation_show_revision_segments", "tenant_isolation_media_assets", "tenant_isolation_show_revision_media_assets", "tenant_isolation_channel_connections", "tenant_isolation_runtime_health_samples", "tenant_isolation_runtime_alerts", "tenant_isolation_live_interactions", "tenant_isolation_channel_reply_drafts", "tenant_isolation_model_releases", "tenant_isolation_show_revision_model_releases", "tenant_isolation_commerce_events", "tenant_isolation_channel_webhook_replays", "tenant_isolation_alert_notification_deliveries", "tenant_isolation_incidents", "tenant_isolation_tenant_entitlements", "tenant_isolation_usage_records", "tenant_isolation_policy_profiles", "tenant_isolation_show_revision_policy_profiles", "tenant_isolation_show_revision_release_manifest_snapshots", "tenant_isolation_show_program_change_requests"];
requiredTables.push("membership_resource_scopes");
requiredColumns.memberships.push("access_scope");
requiredColumns.membership_resource_scopes = ["membership_id", "resource_type", "resource_id"];
requiredIndexes.push("membership_resource_scopes_membership_idx", "membership_resource_scopes_tenant_resource_idx");
rlsTables.add("membership_resource_scopes");
requiredPolicies.push("tenant_isolation_membership_resource_scopes");
const requiredTriggers = ["audit_events_append_only", "audit_events_hash_chain", "usage_records_append_only", "show_revision_product_versions_immutable", "show_revision_segments_immutable", "show_revision_model_releases_immutable", "show_revision_policy_profiles_immutable", "show_revision_media_assets_immutable", "show_revision_release_manifest_snapshots_append_only", "product_versions_governed_immutable", "show_revisions_append_only", "policy_profiles_governed_immutable", "model_releases_governed_immutable", "live_commands_append_only", "media_assets_governed_evidence_mutation", "channel_reply_drafts_governed_mutation", "show_program_change_requests_governed_mutation", "live_runs_governed_show_revision_rebind"];
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
  const runId = randomUUID();
  const draftRunId = randomUUID();
  const commandId = randomUUID();
  const channelId = randomUUID();
  const interactionId = randomUUID();
  const replyId = randomUUID();
  const replyOutboxId = randomUUID();

  await client.query("begin");
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Governed evidence verifier')", [tenantId, `governed-evidence-${tenantId}`]);
    const actor = await client.query("insert into users (external_subject, display_name) values ($1, 'Governed evidence verifier') returning id", [`governed-evidence-${tenantId}`]);
    const actorId = actor.rows[0].id;

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
    await client.query("insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status) values ($1, $2, $3, 3, '{}'::jsonb, 'draft')", [candidateRevisionId, tenantId, showId]);
    await client.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, candidateRevisionId, productVersionId]);
    await client.query("insert into show_program_change_requests (id, tenant_id, live_run_id, source_revision_id, candidate_revision_id, source_program_sha256, created_by) values ($1, $2, $3, $4, $5, repeat('a', 64), $6)", [changeRequestId, tenantId, runId, revisionId, candidateRevisionId, actorId]);
    await expectImmutableRejection("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'late-binding')", [tenantId, candidateRevisionId, productVersionId], "候选节目依赖绑定不得改写");
    await client.query("insert into live_commands (id, tenant_id, live_run_id, actor_id, idempotency_key, expected_state, action, result) values ($1, $2, $3, $4, 'governed-evidence-command', 'DRAFT', 'START', '{}'::jsonb)", [commandId, tenantId, runId, actorId]);
    await expectImmutableRejection("update live_commands set result = '{\"mutated\":true}'::jsonb where id = $1", [commandId], "直播命令不得改写");

    await client.query("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, 'Governed evidence channel', 'normalized-webhook-rtmp', 'connected', 'rtmp', 'kms://governed/channel', $3::jsonb)", [channelId, tenantId, JSON.stringify({ supportsOutboundReplies: true })]);
    await client.query("insert into live_interactions (id, tenant_id, live_run_id, source, channel_connection_id, question_text, risk_level, policy_action, evidence_ids) values ($1, $2, $3, 'channel:governed', $4, 'Can this be sent?', 'low', 'answer', '[\"product_version\"]'::jsonb)", [interactionId, tenantId, runId, channelId]);
    await client.query("insert into channel_reply_drafts (id, tenant_id, live_run_id, interaction_id, channel_connection_id, body, body_sha256, policy_action, evidence_snapshot, created_by) values ($1, $2, $3, $4, $5, 'Initial governed reply', encode(digest('Initial governed reply', 'sha256'), 'hex'), 'answer', '[{\"type\":\"product_version\",\"id\":\"evidence\"}]'::jsonb, $6)", [replyId, tenantId, runId, interactionId, channelId, actorId]);
    await client.query("update channel_reply_drafts set body = 'Edited governed reply', body_sha256 = encode(digest('Edited governed reply', 'sha256'), 'hex'), edited_by = $2 where id = $1", [replyId, actorId]);
    await client.query("update channel_reply_drafts set status = 'pending_approval', submitted_at = now() where id = $1", [replyId]);
    await expectImmutableRejection("update channel_reply_drafts set body = 'Illegal post-submit reply mutation', body_sha256 = encode(digest('Illegal post-submit reply mutation', 'sha256'), 'hex') where id = $1", [replyId], "送审后的渠道回复正文不得改写");
    await client.query("update channel_reply_drafts set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [replyId, actorId]);
    await client.query("insert into outbox_events (id, tenant_id, event_type, aggregate_type, aggregate_id, payload) values ($1, $2, 'channel.reply.dispatch', 'channel_reply_draft', $3, '{}'::jsonb)", [replyOutboxId, tenantId, replyId]);
    await client.query("update channel_reply_drafts set status = 'sending', outbox_event_id = $2 where id = $1", [replyId, replyOutboxId]);
    await expectImmutableRejection("update channel_reply_drafts set channel_connection_id = $2 where id = $1", [replyId, channelId], "投递中的渠道回复不得改写目标渠道");
  } catch (error) {
    errors.push(error instanceof Error ? `治理证据不可变性检查失败：${error.message}` : "治理证据不可变性检查失败");
  } finally {
    await client.query("rollback");
  }
}

async function expectImmutableRejection(statement, parameters, label) {
  await client.query("savepoint governed_evidence_mutation");
  try {
    await client.query(statement, parameters);
    errors.push(`${label}未被数据库触发器拒绝`);
  } catch (error) {
    if (!(error instanceof Error) || !/immutable|only permits|editable only|channel reply/i.test(error.message)) errors.push(`${label}返回了非预期错误：${error instanceof Error ? error.message : "unknown"}`);
  } finally {
    await client.query("rollback to savepoint governed_evidence_mutation");
    await client.query("release savepoint governed_evidence_mutation");
  }
}
