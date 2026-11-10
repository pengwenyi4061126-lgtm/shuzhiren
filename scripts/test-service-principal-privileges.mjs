import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { substitutePsqlIdentifierVariable } from "./lib/sql-lexer.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const principals = ["shuzhiren_runtime_worker", "shuzhiren_avatar_builder", "shuzhiren_channel_adapter", "shuzhiren_alert_notifier"];
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
  await expectTable("shuzhiren_runtime_worker", "avatar_build_jobs", "select", true);
  await expectTable("shuzhiren_runtime_worker", "avatar_build_jobs", "update", true);
  for (const table of ["avatar_build_jobs", "live_runs", "tenants"]) for (const privilege of ["select", "insert", "update", "delete"]) await expectTable("shuzhiren_avatar_builder", table, privilege, false);
  await expectTable("shuzhiren_channel_adapter", "avatar_build_jobs", "select", false);
  await expectTable("shuzhiren_alert_notifier", "avatar_build_jobs", "select", false);
  await expectTable("shuzhiren_runtime_worker", "show_revision_segments", "select", true);
  await expectTable("shuzhiren_runtime_worker", "audit_events", "insert", true);
  await expectTable("shuzhiren_runtime_worker", "memberships", "select", false);
  await expectTable("shuzhiren_runtime_worker", "users", "update", false);
  const functionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_runtime_worker"]);
  assert.equal(functionPrivilege.rows[0].allowed, true, "runtime worker must record its stable service actor only through runtime_worker_actor");
  const adapterFunctionPrivilege = await client.query("select has_function_privilege($1, 'runtime_worker_actor(uuid,text)', 'execute') as allowed", ["shuzhiren_channel_adapter"]);
  assert.equal(adapterFunctionPrivilege.rows[0].allowed, false, "channel adapter must not execute the runtime worker actor function");
  await assertSealedAuditChain();
  await assertWorkerVoiceBindingRead();
  await assertWorkerOverlayRead();
  // 085: the worker records script rotation in the append-only ledger; it can read and insert, never change it.
  for (const [privilege, expected] of [["select", true], ["insert", true], ["update", false], ["delete", false], ["truncate", false]]) await expectTable("shuzhiren_runtime_worker", "live_run_script_plays", privilege, expected);
  for (const principal of ["shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) for (const privilege of ["select", "insert", "update", "delete"]) await expectTable(principal, "live_run_script_plays", privilege, false);

  // 087: the worker reaches approved knowledge only through knowledge_answer_candidates; it has no privilege on the
  // entry, snapshot and document tables or on products, and no other service principal can run the function.
  for (const table of ["knowledge_entries", "knowledge_entry_approvals", "knowledge_documents", "products"]) for (const privilege of ["select", "insert", "update", "delete", "truncate"]) await expectTable("shuzhiren_runtime_worker", table, privilege, false);
  for (const principal of ["shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) for (const table of ["knowledge_entries", "knowledge_entry_approvals", "knowledge_documents"]) await expectTable(principal, table, "select", false);
  for (const [principal, expected] of [["shuzhiren_runtime_worker", true], ["shuzhiren_channel_adapter", false], ["shuzhiren_alert_notifier", false]]) {
    const knowledgeFunction = await client.query("select has_function_privilege($1, 'knowledge_answer_candidates(uuid,uuid,text[],integer)', 'execute') as allowed", [principal]);
    assert.equal(knowledgeFunction.rows[0].allowed, expected, `${principal} must${expected ? "" : " not"} execute knowledge_answer_candidates`);
  }
  // 088: the worker reads the frozen lexicon of a show revision and the tenant's approved term values by column only. It cannot
  // read the change requests (tenant_prohibited_term_revisions: reasons and approvers) and changes none of the three tables.
  for (const table of ["tenant_prohibited_term_revisions", "show_revision_prohibited_term_snapshots", "tenant_prohibited_terms"]) {
    for (const privilege of ["select", "insert", "update", "delete", "truncate"]) await expectTable("shuzhiren_runtime_worker", table, privilege, false);
    for (const principal of ["shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) for (const privilege of ["select", "insert", "update", "delete"]) await expectTable(principal, table, privilege, false);
  }
  for (const [table, columns] of [
    ["show_revision_prohibited_term_snapshots", ["tenant_id", "show_revision_id", "builtin_version", "lexicon", "lexicon_sha256"]],
    ["tenant_prohibited_terms", ["tenant_id", "kind", "builtin_term_id", "term", "normalized_term", "category", "approved_revision", "severity", "suggestions", "disabled", "active"]]
  ]) {
    for (const column of columns) await expectColumn("shuzhiren_runtime_worker", table, column, true);
    for (const principal of ["shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) await expectColumn(principal, table, columns[0], false);
  }
  for (const column of ["id", "approved_at", "created_by", "created_at"]) await expectColumn("shuzhiren_runtime_worker", "tenant_prohibited_terms", column, false);
  for (const column of ["term_count", "created_at"]) await expectColumn("shuzhiren_runtime_worker", "show_revision_prohibited_term_snapshots", column, false);
  for (const column of ["reason", "requested_by", "decided_by", "severity"]) await expectColumn("shuzhiren_runtime_worker", "tenant_prohibited_term_revisions", column, false);
  await expectTable("shuzhiren_backup", "audit_events", "select", true);
  await expectTable("shuzhiren_backup", "audit_events", "update", false);
  await expectTable("shuzhiren_backup", "live_runs", "select", true);
  const backupRole = await client.query("select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = 'shuzhiren_backup'");
  assert.deepEqual(backupRole.rows, [{ rolcanlogin: true, rolinherit: false, rolbypassrls: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }], "backup principal must be the isolated LOGIN NOINHERIT BYPASSRLS role required for complete archive reads");
  const backupSchema = await client.query("select has_schema_privilege('shuzhiren_backup', 'public', 'usage') as allowed, has_database_privilege('shuzhiren_backup', current_database(), 'connect') as can_connect");
  assert.deepEqual(backupSchema.rows, [{ allowed: true, can_connect: true }], "backup principal must retain only archive-read connectivity and schema usage");
  const backupMemberships = await client.query("select count(*)::int as count from pg_auth_members membership join pg_roles member_role on member_role.oid = membership.member where member_role.rolname = 'shuzhiren_backup'");
  assert.equal(backupMemberships.rows[0].count, 0, "backup principal must not inherit another role");
  await assertControlPlanePrincipal();

  console.log("PASS  database service principals and the isolated backup reader retain only their required privileges");
} finally {
  await client.query("rollback").catch(() => undefined);
  await client.end().catch(() => undefined);
}

// L16: seal_audit_event ran as the inserting role, so the worker held INSERT and UPDATE on audit_chain_heads and
// could move a chain head directly, and verify_audit_chain accepted an event whose hash was set to null.
async function assertSealedAuditChain() {
  for (const principal of principals) for (const privilege of ["insert", "update", "delete", "truncate"]) await expectTable(principal, "audit_chain_heads", privilege, false);

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Audit chain sealing'), ($3, $4, 'Audit chain bystander')", [tenantId, `audit-chain-${tenantId}`, otherTenantId, `audit-chain-${otherTenantId}`]);
  const head = async (id) => (await client.query("select last_sequence::int as sequence, last_hash from audit_chain_heads where tenant_id = $1", [id])).rows[0] ?? null;
  const verify = async () => (await client.query("select verified, sealed_events::int as sealed from verify_audit_chain($1::uuid)", [tenantId])).rows[0];
  const rejected = async (role, sql, params) => {
    await client.query("savepoint chain_write");
    try {
      if (role) await client.query(`set local role ${role}`);
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(sql, params);
      return null;
    } catch (error) {
      return error.code;
    } finally {
      await client.query("rollback to savepoint chain_write");
    }
  };

  // The worker still seals its own audit events without any privilege on audit_chain_heads.
  await client.query("set local role shuzhiren_runtime_worker");
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
  const actor = (await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [tenantId])).rows[0].id;
  for (let index = 0; index < 3; index += 1) {
    await client.query("insert into audit_events (tenant_id, actor_id, event_type, resource_type, resource_key, detail) values ($1, $2, 'audit_chain.sealing_probe', 'audit_chain', $3, $4::jsonb)", [tenantId, actor, `probe-${index}`, JSON.stringify({ index })]);
  }
  await client.query("reset role");
  const sealedHead = await head(tenantId);
  assert.equal(sealedHead?.sequence, 3, "the worker's audit events must advance its tenant's chain head");
  assert.equal(await head(otherTenantId), null, "sealing must not touch another tenant's chain head");
  assert.deepEqual(await verify(), { verified: true, sealed: 3 });

  // Direct writes to a chain head are rejected for the worker and for the table owner alike.
  for (const role of ["shuzhiren_runtime_worker", null]) {
    assert.equal(await rejected(role, "update audit_chain_heads set last_sequence = 1, last_hash = repeat('f', 64) where tenant_id = $1", [tenantId]), "42501", `${role ?? "the owner"} must not rewrite a chain head`);
    assert.equal(await rejected(role, "delete from audit_chain_heads where tenant_id = $1", [tenantId]), "42501", `${role ?? "the owner"} must not delete a chain head`);
    assert.equal(await rejected(role, "insert into audit_chain_heads (tenant_id) values ($1)", [otherTenantId]), "42501", `${role ?? "the owner"} must not create a chain head`);
  }
  assert.equal(await rejected(null, "truncate audit_chain_heads", []), "42501", "the owner must not truncate chain heads");
  assert.deepEqual(await head(tenantId), sealedHead, "rejected writes must leave the chain head unchanged");

  // A rewritten event whose hash is nulled out must fail verification (a superuser bypasses the triggers).
  await client.query("savepoint chain_tamper");
  await client.query("set local session_replication_role = replica");
  await client.query("update audit_events set detail = '{\"index\":99}'::jsonb, event_hash = null where tenant_id = $1 and chain_sequence = 3", [tenantId]);
  await client.query("set local session_replication_role = origin");
  assert.equal((await verify()).verified, false, "verify_audit_chain must reject an event whose event_hash was set to null");
  await client.query("rollback to savepoint chain_tamper");
  await client.query("savepoint chain_tamper");
  await client.query("set local session_replication_role = replica");
  await client.query("update audit_events set previous_hash = null where tenant_id = $1 and chain_sequence = 2", [tenantId]);
  await client.query("set local session_replication_role = origin");
  assert.equal((await verify()).verified, false, "verify_audit_chain must reject an event whose previous_hash was set to null");
  await client.query("rollback to savepoint chain_tamper");
  assert.deepEqual(await verify(), { verified: true, sealed: 3 });
}

// H3: scheduleDueRun puts the frozen voice binding on the scheduled start_program. The worker reads it through
// column grants only: the voice id, checksum and approval state, never the asset's name, object key or evidence.
async function assertWorkerVoiceBindingRead() {
  const worker = "shuzhiren_runtime_worker";
  await expectTable(worker, "media_assets", "select", false);
  await expectTable(worker, "show_revision_media_assets", "select", false);
  for (const column of ["id", "runtime_voice_id", "checksum", "approval_status", "expires_at"]) await expectColumn(worker, "media_assets", column, true);
  for (const column of ["name", "object_key", "rights_scope", "source_ref", "verification_evidence_ref", "approved_by"]) await expectColumn(worker, "media_assets", column, false);
  for (const column of ["tenant_id", "show_revision_id", "media_asset_id", "kind"]) await expectColumn(worker, "show_revision_media_assets", column, true);
  for (const privilege of ["insert", "update", "delete"]) {
    await expectTable(worker, "media_assets", privilege, false);
    await expectTable(worker, "show_revision_media_assets", privilege, false);
  }
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Voice binding read'), ($3, $4, 'Voice binding bystander')", [tenantId, `voice-binding-${tenantId}`, otherTenantId, `voice-binding-${otherTenantId}`]);
  const seedBinding = async (tenant, runtimeVoiceId, checksum) => {
    await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    const approver = (await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [tenant])).rows[0].id;
    const show = (await client.query("insert into shows (tenant_id, name) values ($1, 'Voice binding show') returning id", [tenant])).rows[0].id;
    const revision = (await client.query("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, 1, '{}'::jsonb, 'draft') returning id", [tenant, show])).rows[0].id;
    const asset = (await client.query("insert into media_assets (tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status, approved_by, approved_at, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at) values ($1, 'voice', 'Voice binding asset', 'assets/voice.wav', $2, 'Probe rights', 'evidence://probe/rights', 'approved', $3, now(), $4, 'probe-v1', 1024, 'audio/wav', 'evidence://probe/content', now()) returning id", [tenant, checksum, approver, runtimeVoiceId])).rows[0].id;
    await client.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, 'voice')", [tenant, revision, asset]);
    return revision;
  };
  const checksum = `sha256:${"c".repeat(64)}`;
  const revisionId = await seedBinding(tenantId, "probe_voice", checksum);
  const foreignRevisionId = await seedBinding(otherTenantId, "foreign_voice", `sha256:${"d".repeat(64)}`);
  // The exact query of scheduleDueRun in apps/runtime-worker/index.mjs.
  const bindingQuery = `select asset.runtime_voice_id, asset.checksum
        from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id
        where binding.tenant_id = $1 and binding.show_revision_id = $2 and binding.kind = 'voice'
          and asset.approval_status = 'approved' and (asset.expires_at is null or asset.expires_at >= current_date)`;
  // A template literal's line breaks are always LF, while a Windows checkout with core.autocrlf=true has CRLF in
  // the worker source; compare both with LF line endings (the query text itself must still match verbatim).
  const workerSource = (await readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.ok(workerSource.includes(bindingQuery), "the probe must run the runtime worker's voice binding query verbatim");
  await client.query("savepoint voice_binding_read");
  try {
    await client.query(`set local role ${worker}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    assert.deepEqual((await client.query(bindingQuery, [tenantId, revisionId])).rows, [{ runtime_voice_id: "probe_voice", checksum }], "the runtime worker must read its tenant's frozen voice binding");
    assert.deepEqual((await client.query(bindingQuery, [otherTenantId, foreignRevisionId])).rows, [], "row security must hide another tenant's voice binding from the runtime worker");
    await client.query("savepoint voice_binding_column");
    await assert.rejects(client.query("select object_key from media_assets"), (error) => error.code === "42501", "the runtime worker must not read media asset object keys");
    await client.query("rollback to savepoint voice_binding_column");
  } finally {
    await client.query("rollback to savepoint voice_binding_read");
  }
}

async function assertWorkerOverlayRead() {
  const worker = "shuzhiren_runtime_worker";
  await expectTable(worker, "show_revision_overlays", "select", false);
  for (const column of ["tenant_id", "show_revision_id", "scene_json", "scene_sha256"]) await expectColumn(worker, "show_revision_overlays", column, true);
  for (const column of ["caption_enabled", "caption_position", "product_card_enabled", "product_card_anchor", "price_sticker_enabled", "background_mode", "background_media_asset_id", "background_options", "frozen_at", "updated_by", "updated_at"]) {
    await expectColumn(worker, "show_revision_overlays", column, false);
  }
  for (const privilege of ["insert", "update", "delete", "truncate"]) await expectTable(worker, "show_revision_overlays", privilege, false);
  for (const principal of ["shuzhiren_channel_adapter", "shuzhiren_alert_notifier"]) {
    await expectTable(principal, "show_revision_overlays", "select", false);
    for (const column of ["tenant_id", "show_revision_id", "scene_json", "scene_sha256"]) await expectColumn(principal, "show_revision_overlays", column, false);
  }

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  await client.query("insert into tenants (id, slug, name) values ($1, $2, 'Overlay read'), ($3, $4, 'Overlay bystander')", [tenantId, `overlay-read-${tenantId}`, otherTenantId, `overlay-read-${otherTenantId}`]);
  const createOverlay = async (tenant) => {
    await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    const actor = (await client.query("select runtime_worker_actor($1::uuid, 'runtime-worker') as id", [tenant])).rows[0].id;
    const showId = (await client.query("insert into shows (tenant_id, name) values ($1, 'Overlay read') returning id", [tenant])).rows[0].id;
    const revisionId = (await client.query("insert into show_revisions (tenant_id, show_id, revision, plan, approval_status) values ($1, $2, 1, '{}'::jsonb, 'draft') returning id", [tenant, showId])).rows[0].id;
    await client.query("insert into show_revision_overlays (tenant_id, show_revision_id, updated_by) values ($1, $2, $3)", [tenant, revisionId, actor]);
    return revisionId;
  };
  const revisionId = await createOverlay(tenantId);
  const otherRevisionId = await createOverlay(otherTenantId);
  await client.query("savepoint overlay_worker_read");
  try {
    await client.query(`set local role ${worker}`);
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const query = "select tenant_id, show_revision_id, scene_json, scene_sha256 from show_revision_overlays where tenant_id = $1 and show_revision_id = $2";
    assert.deepEqual((await client.query(query, [tenantId, revisionId])).rows, [{ tenant_id: tenantId, show_revision_id: revisionId, scene_json: null, scene_sha256: null }]);
    assert.deepEqual((await client.query(query, [otherTenantId, otherRevisionId])).rows, [], "RLS must hide overlays from another tenant");
    await client.query("savepoint overlay_worker_column");
    await assert.rejects(client.query("select caption_enabled from show_revision_overlays where show_revision_id = $1", [revisionId]), (error) => error.code === "42501");
    await client.query("rollback to savepoint overlay_worker_column");
  } finally {
    await client.query("rollback to savepoint overlay_worker_read");
  }
}
// D4 (2026-11-05): a dedicated migration owner (BYPASSRLS) owns every schema object, and the control plane connects
// as shuzhiren_control_plane, which owns nothing and gets its DML from control-plane-principal.sql. This replays the
// Runbook path of an existing deployment whose application account owned the tables: REASSIGN OWNED moves the
// objects to the migration owner, which then runs the principal scripts. Everything is rolled back afterwards.
async function assertControlPlanePrincipal() {
  const controlPlane = "shuzhiren_control_plane";
  const owner = "shuzhiren_migration_owner";
  const legacy = `shuzhiren_d4_legacy_${process.pid}`;
  const objectsOwnedBy = async (role) => (await client.query(`select kind, name from (
      select 'relation' as kind, c.oid::regclass::text as name, c.relowner as owner_oid, c.oid as oid, 'pg_class'::regclass as catalog
        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
      union all
      select 'function', p.oid::regprocedure::text, p.proowner, p.oid, 'pg_proc'::regclass from pg_proc p where p.pronamespace = 'public'::regnamespace
      union all
      select 'type', t.oid::regtype::text, t.typowner, t.oid, 'pg_type'::regclass from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e', 'd')
    ) object
    where object.owner_oid = (select oid from pg_roles where rolname = $1)
      and not exists (select 1 from pg_depend d where d.classid = object.catalog and d.objid = object.oid and d.deptype = 'e')
    order by kind, name`, [role])).rows;
  await client.query("savepoint d4_principal");
  try {
    await client.query(`create role ${legacy} nologin`);
    await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${owner}') then create role ${owner} nologin noinherit bypassrls; end if; end $$;`);
    await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${controlPlane}') then create role ${controlPlane} nologin noinherit; end if; end $$;`);
    // The legacy layout: the application account owns every migration object (extension members excluded).
    const migrationObjects = await objectsOwnedBy((await client.query("select current_user as role")).rows[0].role);
    assert.ok(migrationObjects.some((object) => object.name === "channel_connections"), "the probe must find the migration objects to hand over");
    for (const object of migrationObjects) await client.query(`alter ${object.kind === "relation" ? "table" : object.kind} ${object.name} owner to ${legacy}`);
    // Runbook steps for an existing deployment, run by a superuser inside the dedicated database: the migration
    // owner also owns the database (so it may create objects in public and install trusted extensions), then
    // REASSIGN OWNED hands it every object of the old owner.
    await client.query(`do $$ begin execute format('alter database %I owner to ${owner}', current_database()); end $$;`);
    await client.query(`reassign owned by ${legacy} to ${owner}`);
    assert.deepEqual(await objectsOwnedBy(legacy), [], "REASSIGN OWNED must leave the old application account owning nothing");
    assert.equal((await objectsOwnedBy(owner)).length, migrationObjects.length, "the migration owner must own every migration object");

    // The migration owner runs the principal scripts; control-plane-principal.sql twice, so a rerun is a no-op.
    const controlPlaneGrants = substitutePsqlIdentifierVariable(await readFile(new URL("../infra/postgres/control-plane-principal.sql", import.meta.url), "utf8"), "control_plane_role", controlPlane);
    await client.query(`set local role ${owner}`);
    await client.query(grants);
    await client.query(controlPlaneGrants);
    await client.query("reset role");
    const aclSnapshot = async () => (await client.query("select c.relname, c.relacl::text as acl from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'S') order by c.relname")).rows;
    const firstRun = await aclSnapshot();
    await client.query(`grant truncate, references on live_runs to ${controlPlane}`);
    await client.query(`set local role ${owner}`);
    await client.query(controlPlaneGrants);
    await client.query("reset role");
    assert.deepEqual(await aclSnapshot(), firstRun, "rerunning control-plane-principal.sql must restore exactly its own grants");

    assert.deepEqual(await objectsOwnedBy(controlPlane), [], "the control-plane account must not own any table, sequence, function or type");
    const attributes = (await client.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [controlPlane])).rows[0];
    assert.deepEqual(attributes, { rolsuper: false, rolbypassrls: false }, "the control-plane account must not bypass RLS");
    const tables = (await client.query("select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by c.relname")).rows.map((row) => row.relname);
    const readOnly = new Set(["schema_migrations", "audit_chain_heads", "runtime_presets"]);
    for (const table of tables) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const expected = table === "membership_admin_guards" ? false : readOnly.has(table) ? privilege === "select" : true;
        await expectTable(controlPlane, table, privilege, expected);
      }
      for (const privilege of ["truncate", "references", "trigger"]) await expectTable(controlPlane, table, privilege, false);
    }
    for (const table of ["channel_connections", "settlement_batches", "settlement_lines", "settlement_reconciliation_exceptions"]) assert.ok(tables.includes(table), `${table} must exist for the control-plane grant check`);

    // Behavior under the control-plane role: governed DML works, the ledger and chain heads stay read-only.
    const tenantId = randomUUID();
    const channelId = randomUUID();
    const asControlPlane = async (sql, params = []) => {
      await client.query("savepoint d4_statement");
      try {
        await client.query(`set local role ${controlPlane}`);
        await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await client.query(sql, params);
        await client.query("reset role");
        await client.query("release savepoint d4_statement");
        return { rowCount: result.rowCount, rows: result.rows };
      } catch (error) {
        // Rolling back to the savepoint also undoes SET LOCAL ROLE.
        await client.query("rollback to savepoint d4_statement");
        await client.query("release savepoint d4_statement");
        return { code: error.code };
      }
    };
    assert.equal((await asControlPlane("insert into tenants (id, slug, name) values ($1, $2, 'D4 control plane')", [tenantId, `d4-${tenantId}`])).rowCount, 1);
    assert.equal((await asControlPlane("insert into channel_connections (id, tenant_id, name, provider, status, output_protocol, secret_ref, capabilities) values ($1, $2, 'D4 channel', 'generic-rtmp', 'disabled', 'rtmp', 'secret://d4/channel', '{}'::jsonb)", [channelId, tenantId])).rowCount, 1, "the control plane must insert channel connections");
    assert.equal((await asControlPlane("update channel_connections set status = 'disabled' where id = $1", [channelId])).rowCount, 1, "the control plane must update channel connections");
    assert.ok(Number((await asControlPlane("select count(*)::int as count from schema_migrations")).rows?.[0]?.count) > 0, "the control plane must read the migration ledger");
    assert.equal((await asControlPlane("insert into schema_migrations (name, checksum) values ('999_forged.sql', repeat('0', 64))")).code, "42501", "the control plane must not record migrations");
    assert.equal((await asControlPlane("delete from schema_migrations")).code, "42501", "the control plane must not delete migration records");
    assert.equal((await asControlPlane("update audit_chain_heads set last_sequence = 0")).code, "42501", "the control plane must not write chain heads");
    assert.equal((await asControlPlane("select * from membership_admin_guards")).code, "42501", "the control plane needs no access to the admin guard table");
    // 082: the platform preset catalogue is read-only for the control plane.
    assert.ok(Number((await asControlPlane("select count(*)::int as count from runtime_presets where enabled")).rows?.[0]?.count) > 0, "the control plane must read the preset catalogue");
    assert.equal((await asControlPlane("update runtime_presets set enabled = false")).code, "42501", "the control plane must not change the preset catalogue");

    // alter default privileges: a table the migration owner creates later is writable by the control plane at once.
    await client.query(`set local role ${owner}`);
    await client.query("create table d4_default_privilege_probe (id integer primary key)");
    await client.query("reset role");
    for (const privilege of ["select", "insert", "update", "delete"]) await expectTable(controlPlane, "d4_default_privilege_probe", privilege, true);
  } finally {
    await client.query("rollback to savepoint d4_principal");
  }
}
async function expectColumn(principal, table, column, expected) {
  const result = await client.query("select has_column_privilege($1, $2, $3, 'select') as allowed", [principal, table, column]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} select on ${table}.${column}`);
}
async function expectTable(principal, table, privilege, expected) {
  const result = await client.query("select has_table_privilege($1, $2, $3) as allowed", [principal, table, privilege]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} ${privilege} on ${table}`);
}
