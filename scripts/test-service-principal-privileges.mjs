import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  await assertSealedAuditChain();
  await assertWorkerVoiceBindingRead();

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
  const workerSource = await readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8");
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
async function expectColumn(principal, table, column, expected) {
  const result = await client.query("select has_column_privilege($1, $2, $3, 'select') as allowed", [principal, table, column]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} select on ${table}.${column}`);
}
async function expectTable(principal, table, privilege, expected) {
  const result = await client.query("select has_table_privilege($1, $2, $3) as allowed", [principal, table, privilege]);
  assert.equal(result.rows[0].allowed, expected, `${principal} ${expected ? "must retain" : "must not receive"} ${privilege} on ${table}`);
}
