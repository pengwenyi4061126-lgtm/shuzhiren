// AI identity disclosure rule in the live-run preflight (live-commerce-p1-features, task 1.6; requirements 1.2, 1.3,
// 1.5, 1.6, 1.7, 1.10, 7.9) against a real PostgreSQL cluster. The console store runs as shuzhiren_control_plane
// (no SUPERUSER, no BYPASSRLS): arm (advanceRunLifecycle) and START (issueCommand) read the tenant's
// default_key = 'ai_disclosure' rule on the transaction connection that holds the run lock.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";
import { MEDIA_KINDS, MODEL_COMPONENTS } from "./lib/seed.mjs";

let h;
let store;
let rules;
let database;
let aigc;
let gateway;

const CHANNEL_CAPABILITIES = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsOutboundReplies: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
const gatewayLabel = (text) => ({ status: "ok", dependencies: { livetalking: { available: true, aigc_label: { enabled: true, text, position: "top-right", frames_labelled: 250, last_error: null } } } });

before(async () => {
  h = await createHarness(import.meta.url);
  gateway = await h.stub();
  // The console modules read these when first used: connect them as the control plane, with a Gateway stub that
  // reports the AIGC label enabled, so that the AI disclosure rule is the only preflight input under test.
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY", "AIGC_LABEL_TEXT"]) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: h.url("control_plane"), RUNTIME_GATEWAY_URL: gateway.baseUrl, RUNTIME_GATEWAY_DEMO_MODE: "false", AIGC_CONTENT_PRODUCER: "Integration Operator" });
  register("../lib/console-ts-loader.mjs", import.meta.url);
  store = await import("../../apps/console/lib/control-plane/store.ts");
  rules = await import("../../apps/console/lib/interaction-rules.ts");
  database = await import("../../apps/console/lib/database.ts");
  aigc = await import("../../apps/console/lib/aigc-label.ts");
  gateway.route("GET", "/healthz", () => ({ status: 200, json: gatewayLabel(aigc.aigcLabelText()) }));
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await h?.close();
});

/**
 * A tenant with one run in `state` whose other preflight inputs all pass: frozen product, model releases, media
 * rights, policy profile, a fallback segment, a connected channel, a fresh runtime health sample, a bound runtime
 * session and an operator.
 */
async function fixture({ state = "PREFLIGHT" } = {}) {
  const { seed, admin } = h;
  const tenantId = await seed.tenant();
  const subject = `it-aid-${randomUUID()}`;
  const memberId = await seed.member({ tenantId, subject, displayName: "口播规则测试场控", role: "operator" });
  const revision = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false, segments: [{ kind: "prepared_product", runtimeScript: "本段仅播报已批准的商品事实。" }, { kind: "fallback", runtimeScript: "备用节目。" }] });
  const { revisionId } = revision;
  // Bindings as seed.revision(bindings: "full") writes them, except for a product version whose facts are current.
  const now = Date.now();
  const facts = { priceCent: 9900, stock: 20, highlights: ["按压泡沫"], faq: [], sourceRef: "pim://integration/preflight", sourceSyncedAt: new Date(now).toISOString(), validFrom: new Date(now - 5 * 60_000).toISOString() };
  const productVersionId = await seed.productVersion({ tenantId, approver: memberId, facts });
  await admin.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, productVersionId]);
  for (const component of MODEL_COMPONENTS) {
    const releaseId = await seed.modelRelease({ tenantId, approver: memberId, component });
    await admin.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revisionId, releaseId, component]);
  }
  for (const kind of MEDIA_KINDS) {
    const assetId = await seed.mediaAsset({ tenantId, approver: memberId, kind });
    await admin.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revisionId, assetId, kind]);
  }
  const policyProfileId = await seed.policyProfile({ tenantId, approver: memberId });
  await admin.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
  await admin.query("insert into show_revision_prohibited_term_snapshots (tenant_id, show_revision_id, builtin_version, lexicon, lexicon_sha256, term_count) values ($1, $2, 'integration-seed', '[]'::jsonb, repeat('0', 64), 0)", [tenantId, revisionId]);
  await admin.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, memberId]);
  const channelId = await seed.channelConnection({ tenantId, verifier: memberId, capabilities: CHANNEL_CAPABILITIES });
  const runId = await seed.liveRun({ tenantId, revisionId, state, channelId, productVersionId });
  await admin.query("update live_runs set has_operator = true, rights_approved = true, has_approved_sku_version = true, has_fallback_program = true, channel_ready = true, output_ready = true, ai_disclosure_enabled = true where id = $1", [runId]);
  await seed.healthSample({ tenantId, liveRunId: runId });
  return { tenantId, memberId, runId, context: { tenantId, actorId: subject, actorName: "口播规则测试场控", role: "operator", accessScope: "tenant" } };
}

const ruleContext = (f) => ({ ...f.context, role: "admin" });
const countAudit = async (f, type) => Number((await h.snapshot("select count(*)::int as n from audit_events where tenant_id = $1 and event_type = $2 and resource_key = $3", [f.tenantId, type, f.runId]))[0].n);
const countCommands = async (f) => Number((await h.snapshot("select count(*)::int as n from live_commands where tenant_id = $1 and live_run_id = $2", [f.tenantId, f.runId]))[0].n);
const runState = async (f) => (await h.snapshot("select state from live_runs where id = $1", [f.runId]))[0].state;
const snapshotOf = async (f) => ({ state: await runState(f), arm: await countAudit(f, "live_run.arm"), accepted: await countAudit(f, "live_command.accepted"), commands: await countCommands(f) });

/** Runs `action` and returns how many connections it took from the console's pool. */
async function pooledConnections(action) {
  const pool = database.databasePool();
  assert.ok(pool, "the console must be connected to PostgreSQL");
  let connects = 0;
  pool.connect = (...args) => { connects += 1; return Object.getPrototypeOf(pool).connect.apply(pool, args); };
  try {
    await action();
  } finally {
    delete pool.connect;
  }
  return connects;
}

const preflightChecks = async (f) => {
  const run = await store.getRun(f.context, f.runId);
  const result = await store.evaluateRunPreflight(f.context, run);
  return { passed: result.passed, byId: Object.fromEntries(result.checks.map((check) => [check.id, check])) };
};
const isConflict = (error) => error instanceof Response && error.status === 409;
const arm = (f) => store.advanceRunLifecycle(f.context, f.runId, "arm");
const start = (f, key = `it-aid-start-${randomUUID()}`) => store.issueCommand(f.context, f.runId, { action: "START", expectedState: "ARMED", idempotencyKey: key });

describe("arm against no rule, a pending rule and an approved rule", () => {
  test("the same run is refused twice with nothing written, then passes the check once the rule is approved", async () => {
    const f = await fixture();
    const before = await snapshotOf(f);

    let connects = await pooledConnections(() => assert.rejects(arm(f), isConflict, "arm without an AI disclosure rule"));
    assert.equal(connects, 1, "arm must read the rule on its own transaction connection");
    let { byId } = await preflightChecks(f);
    assert.deepEqual([byId.ai_disclosure_rule.status, byId.ai_disclosure_rule.detail], ["blocked", "未创建 AI 身份提示规则（在\"互动规则\"页一键创建默认规则并审批）"]);
    assert.deepEqual(byId.aigc_label.status, "passed", "every other input is ready, so the missing rule is the only blocker");
    assert.deepEqual(await snapshotOf(f), before, "a refused arm writes no live_run.arm audit event, no live_commands row and keeps the state");

    const { created } = await rules.createDefaultInteractionRules(ruleContext(f));
    const ai = created.find((rule) => rule.defaultKey === "ai_disclosure");
    assert.ok(ai, "the defaults include the AI identity disclosure rule");
    connects = await pooledConnections(() => assert.rejects(arm(f), isConflict, "arm with a pending AI disclosure rule"));
    assert.equal(connects, 1);
    ({ byId } = await preflightChecks(f));
    assert.deepEqual([byId.ai_disclosure_rule.status, byId.ai_disclosure_rule.detail], ["blocked", "AI 身份提示规则待审批"]);
    assert.deepEqual(await snapshotOf(f), before);

    await rules.approveInteractionRule(ruleContext(f), ai.id);
    let armed;
    connects = await pooledConnections(async () => { armed = await arm(f); });
    assert.equal(connects, 1, "an accepted arm still uses the single transaction connection");
    assert.equal(armed.state, "ARMED");
    const interval = (await h.snapshot("select interval_seconds from interaction_rules where id = $1", [ai.id]))[0].interval_seconds;
    assert.deepEqual(await snapshotOf(f), { state: "ARMED", arm: 1, accepted: 0, commands: 0 });
    const outcome = await store.evaluateRunPreflight(f.context, await store.getRun(f.context, f.runId));
    assert.equal(outcome.passed, true, "with the rule approved every preflight check passes");
    assert.deepEqual(outcome.checks.find((check) => check.id === "ai_disclosure_rule"), { id: "ai_disclosure_rule", label: "AI 身份口播规则", status: "passed", detail: `已批准，每 ${interval} 秒口播一次` });
  });

  test("an approved rule of another tenant does not make this tenant pass (RLS)", async () => {
    const other = await fixture();
    const { created } = await rules.createDefaultInteractionRules(ruleContext(other));
    for (const rule of created) await rules.approveInteractionRule(ruleContext(other), rule.id);
    assert.equal((await preflightChecks(other)).byId.ai_disclosure_rule.status, "passed", "the other tenant's own check passes");

    const f = await fixture();
    const before = await snapshotOf(f);
    const connects = await pooledConnections(() => assert.rejects(arm(f), isConflict));
    assert.equal(connects, 1);
    const { byId } = await preflightChecks(f);
    assert.equal(byId.ai_disclosure_rule.status, "blocked");
    assert.match(byId.ai_disclosure_rule.detail, /^未创建 AI 身份提示规则/, "the tenant sees no rule, not the other tenant's");
    assert.deepEqual(await snapshotOf(f), before);
    // The control-plane account only sees its own tenant's row under the tenant context.
    const client = await h.connectAs("control_plane");
    try {
      const seen = await h.withTenant(client, f.tenantId, (c) => c.query("select count(*)::int as n from interaction_rules where default_key = 'ai_disclosure'"));
      assert.equal(seen.rows[0].n, 0);
    } finally {
      await client.end();
    }
  });
});

describe("START against no rule, a pending rule and an approved rule", () => {
  test("a run that is already ARMED is refused by START until the rule is approved, on one connection", async () => {
    const f = await fixture({ state: "ARMED" });
    const before = await snapshotOf(f);

    let connects = await pooledConnections(() => assert.rejects(start(f), isConflict, "START without an AI disclosure rule"));
    assert.equal(connects, 1, "START must read the rule on its own transaction connection");
    assert.deepEqual(await snapshotOf(f), before, "a refused START writes no live_commands row and no audit event");
    assert.equal((await preflightChecks(f)).byId.ai_disclosure_rule.status, "blocked");

    const { created } = await rules.createDefaultInteractionRules(ruleContext(f));
    const ai = created.find((rule) => rule.defaultKey === "ai_disclosure");
    connects = await pooledConnections(() => assert.rejects(start(f), isConflict, "START with a pending AI disclosure rule"));
    assert.equal(connects, 1);
    assert.deepEqual(await snapshotOf(f), before);
    assert.equal((await preflightChecks(f)).byId.ai_disclosure_rule.detail, "AI 身份提示规则待审批");

    await rules.approveInteractionRule(ruleContext(f), ai.id);
    let accepted;
    connects = await pooledConnections(async () => { accepted = await start(f); });
    assert.equal(connects, 1, "an accepted START still uses the single transaction connection");
    assert.equal(accepted.duplicate, false);
    assert.deepEqual(await snapshotOf(f), { ...before, commands: 1, accepted: 1 });
  });
});
