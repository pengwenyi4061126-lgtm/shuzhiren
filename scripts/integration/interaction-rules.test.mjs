// Live interaction rules (migration 084) against a real PostgreSQL cluster: the console creates and approves
// rules and ingests channel viewer events as shuzhiren_control_plane; the runtime worker's evaluator
// (apps/runtime-worker/interaction-rules.mjs) runs as shuzhiren_runtime_worker with the grants of
// infra/postgres/service-principals.sql and queues speech.dispatch events or reply drafts.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";
import { inTenantTransaction } from "../../apps/runtime-worker/db.mjs";
import { createInteractionRuleEvaluator, interactionRuleConfig, NEUTRAL_NICKNAME } from "../../apps/runtime-worker/interaction-rules.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let h;
let workerPool;
let consoleRules;
let consoleInteractions;

before(async () => {
  h = await createHarness(import.meta.url);
  workerPool = h.pool("runtime_worker", { max: 4 });
  // The console modules read DATABASE_URL when their pool is first used: connect them as the control plane.
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY"]) delete process.env[name];
  process.env.DATABASE_URL = h.url("control_plane");
  register("../lib/console-ts-loader.mjs", import.meta.url);
  consoleRules = await import("../../apps/console/lib/interaction-rules.ts");
  consoleInteractions = await import("../../apps/console/lib/interactions.ts");
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await h?.close();
});

function evaluator(tenantId, overrides = {}) {
  return createInteractionRuleEvaluator({
    tenantIds: async () => [tenantId],
    inTenantTransaction: (tenant, operation) => inTenantTransaction(workerPool, tenant, operation),
    config: { ...interactionRuleConfig({}), ...overrides },
    maxOutboxAttempts: 6,
    random: () => 0
  });
}

/** A tenant with one LIVE run whose approved revision freezes a current product version, a voice and a policy profile. */
async function fixture({ policyRules = [{ id: "tenant_terms", terms: ["绝对安全"], reason: "租户禁用词", action: "refuse", riskLevel: "high", requiredEvidence: [] }] } = {}) {
  const { seed, admin } = h;
  const tenantId = await seed.tenant();
  const subject = `it-rules-${randomUUID()}`;
  const memberId = await seed.member({ tenantId, subject, displayName: "规则测试管理员" });
  const productId = randomUUID();
  await admin.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, '氨基酸洁面慕斯')", [productId, tenantId, `it-rules-${productId}`]);
  const now = Date.now();
  const productVersionId = await seed.productVersion({ tenantId, approver: memberId, productId, facts: { priceCent: 9900, stock: 20, highlights: ["按压泡沫"], faq: [], sourceRef: "pim://integration/rules", sourceSyncedAt: new Date(now).toISOString(), validFrom: new Date(now - 5 * 60_000).toISOString() } });
  const { revisionId } = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false });
  await admin.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, productVersionId]);
  const voiceAssetId = await seed.mediaAsset({ tenantId, approver: memberId, kind: "voice" });
  await admin.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, 'voice')", [tenantId, revisionId, voiceAssetId]);
  const policyProfileId = await seed.policyProfile({ tenantId, approver: memberId, rules: policyRules });
  await admin.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
  await admin.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, memberId]);
  const channelId = await seed.channelConnection({ tenantId, verifier: memberId });
  const sessionId = `it_rules_${randomUUID().slice(0, 8)}`;
  const runId = await seed.liveRun({ tenantId, revisionId, state: "LIVE", sessionId, channelId, productVersionId });
  const voice = (await admin.query("select runtime_voice_id, checksum from media_assets where id = $1", [voiceAssetId])).rows[0];
  return { tenantId, subject, memberId, productVersionId, revisionId, channelId, runId, sessionId, voice, context: { tenantId, actorId: subject, actorName: "规则测试管理员", role: "admin" } };
}

async function insertRule(f, rule) {
  const id = randomUUID();
  await h.admin.query(`insert into interaction_rules (id, tenant_id, live_run_id, name, trigger_type, match_config, templates, action, cooldown_seconds, interval_seconds, priority, created_by)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`,
  [id, f.tenantId, rule.liveRunId ?? null, rule.name ?? "规则", rule.triggerType, JSON.stringify(rule.matchConfig ?? {}), JSON.stringify(rule.templates), rule.action ?? "speak", rule.cooldownSeconds ?? 0, rule.intervalSeconds ?? null, rule.priority ?? 100, f.memberId]);
  if (rule.approve !== false) await h.admin.query("update interaction_rules set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [id, f.memberId]);
  return id;
}

async function insertInteraction(f, { kind = "viewer_enter", text = "观众进入直播间", viewer = "viewer-1", nickname = "小明", policyAction = "answer", giftValueCents = null, channel = true } = {}) {
  const id = randomUUID();
  await h.admin.query(`insert into live_interactions (id, tenant_id, live_run_id, source, channel_connection_id, question_text, risk_level, policy_action, interaction_kind, viewer_ref, viewer_nickname, gift_value_cents, status)
    values ($1, $2, $3, 'channel:integration', $4, $5, 'low', $6, $7, $8, $9, $10, $11)`,
  [id, f.tenantId, f.runId, channel ? f.channelId : null, text, policyAction, kind, viewer ? sha256(viewer) : null, nickname, giftValueCents, kind === "comment" ? "queued" : "handled"]);
  return id;
}

const speeches = async (f) => (await h.admin.query("select id, state, payload, created_at from outbox_events where tenant_id = $1 and event_type = 'speech.dispatch' order by created_at, id", [f.tenantId])).rows;
// Firings of one pass share the transaction's now(); their interactions' insertion order breaks the tie.
const firings = async (f) => (await h.admin.query("select f.* from interaction_rule_firings f left join live_interactions i on i.id = f.interaction_id where f.tenant_id = $1 order by f.created_at, i.created_at nulls first, f.id", [f.tenantId])).rows;
/** The Gateway accepted every queued speech long enough ago for the global interval to have passed. */
const deliverAndAge = (f, seconds = 120) => h.admin.query("update outbox_events set state = 'delivered', delivered_at = now(), created_at = created_at - make_interval(secs => $2) where tenant_id = $1 and event_type = 'speech.dispatch'", [f.tenantId, seconds]);

describe("defaults, approval and the speech path", () => {
  test("approved defaults speak the AI disclosure first, then the timed product line and a welcome, with the frozen voice and product", async () => {
    const f = await fixture();
    const { created } = await consoleRules.createDefaultInteractionRules(f.context);
    assert.equal(created.length, 5);
    assert.equal((await consoleRules.createDefaultInteractionRules(f.context)).created.length, 0, "default creation is idempotent per tenant");
    const run = evaluator(f.tenantId);
    assert.equal((await run.runOnce()).recorded, 0, "pending rules never fire");
    for (const rule of created) await consoleRules.approveInteractionRule(f.context, rule.id);

    await run.runOnce();
    let queued = await speeches(f);
    assert.equal(queued.length, 1, "one automatic line per pass");
    const ai = created.find((rule) => rule.defaultKey === "ai_disclosure");
    const { sessionId, command } = queued[0].payload;
    assert.equal(sessionId, f.sessionId);
    assert.ok(ai.templates.includes(command.text), "the AI identity disclosure outranks every other rule");
    assert.deepEqual({ voice: command.voice, voiceChecksum: command.voiceChecksum, productVersionId: command.productVersionId, productRevision: command.productRevision, interrupt: command.interrupt, runId: command.runId }, { voice: f.voice.runtime_voice_id, voiceChecksum: f.voice.checksum, productVersionId: f.productVersionId, productRevision: 1, interrupt: false, runId: f.runId });
    assert.match(command.id, /^rule_[0-9a-f]{32}$/);
    const [aiFiring] = await firings(f);
    assert.deepEqual([aiFiring.rule_id, aiFiring.outcome, aiFiring.outbox_event_id, aiFiring.rendered_text_sha256], [ai.id, "speech_queued", queued[0].id, sha256(command.text)]);
    assert.match(aiFiring.trigger_key, /^slot:\d+$/);
    const audit = await h.admin.query("select detail from audit_events where tenant_id = $1 and event_type = 'interaction_rule.speech_queued'", [f.tenantId]);
    assert.equal(audit.rows[0].detail.outboxEventId, queued[0].id);

    await run.runOnce();
    assert.equal((await speeches(f)).length, 1, "nothing more while the first speech is pending");
    assert.equal((await firings(f)).length, 1, "a deferred timer records nothing and waits inside its slot");

    await deliverAndAge(f);
    await run.runOnce();
    queued = await speeches(f);
    assert.equal(queued.length, 2);
    assert.match(queued[1].payload.command.text, /氨基酸洁面慕斯.*99\.00元/, "the timed line uses the approved product name and price");

    await deliverAndAge(f);
    const interaction = await consoleInteractions.createChannelInteraction(f.context, { runId: f.runId, question: "观众进入直播间", source: "channel:integration", externalEventId: `enter-${randomUUID()}`, evidenceIds: [], channelConnectionId: f.channelId, interactionKind: "viewer_enter", viewerRef: sha256("viewer-42"), viewerNickname: "小\u200B明\u0007" });
    assert.equal(interaction.status, "handled", "a viewer event stays out of the operator queue");
    await run.runOnce();
    queued = await speeches(f);
    assert.equal(queued.length, 3);
    assert.match(queued[2].payload.command.text, /^(欢迎小明|小明来啦)/);
    const welcome = (await firings(f)).at(-1);
    assert.deepEqual([welcome.interaction_id, welcome.viewer_ref, welcome.trigger_key], [interaction.id, sha256("viewer-42"), `interaction:${interaction.id}`]);
    assert.ok((await h.admin.query("select rules_evaluated_at from live_interactions where id = $1", [interaction.id])).rows[0].rules_evaluated_at);

    const before = (await firings(f)).length;
    await deliverAndAge(f);
    await run.runOnce();
    assert.equal((await firings(f)).filter((row) => row.interaction_id === interaction.id).length, 1, "an interaction is evaluated once");
    assert.ok((await firings(f)).length >= before);
  });
});

describe("rate limits, cooldowns, policy and idempotency", () => {
  test("one line per pass, then the global interval and the viewer cooldown suppress further welcomes", async () => {
    const f = await fixture();
    await insertRule(f, { triggerType: "viewer_enter", templates: ["欢迎{nickname}"] });
    const first = await insertInteraction(f, { viewer: "a", nickname: "阿甲" });
    const second = await insertInteraction(f, { viewer: "b", nickname: "阿乙" });
    const run = evaluator(f.tenantId);
    await run.runOnce();
    let rows = await firings(f);
    assert.deepEqual(rows.map((row) => [row.interaction_id, row.outcome, row.outcome_reason]), [[first, "speech_queued", null], [second, "suppressed", "speech_budget_used"]]);
    assert.equal((await speeches(f))[0].payload.command.text, "欢迎阿甲");

    await h.admin.query("update outbox_events set state = 'delivered', delivered_at = now() where tenant_id = $1", [f.tenantId]);
    const third = await insertInteraction(f, { viewer: "c", nickname: "阿丙" });
    await run.runOnce();
    rows = await firings(f);
    assert.deepEqual([rows.at(-1).interaction_id, rows.at(-1).outcome_reason], [third, "global_speech_interval"]);

    await deliverAndAge(f);
    const again = await insertInteraction(f, { viewer: "a", nickname: "阿甲" });
    await run.runOnce();
    rows = await firings(f);
    assert.deepEqual([rows.at(-1).interaction_id, rows.at(-1).outcome_reason], [again, "viewer_cooldown"]);
    assert.equal((await speeches(f)).length, 1);
  });

  test("a rule cooldown suppresses the rule; a lower-priority rule outside its cooldown answers instead", async () => {
    const f = await fixture();
    const thanks = await insertRule(f, { triggerType: "follow", templates: ["感谢{nickname}的关注"], cooldownSeconds: 3600, priority: 500 });
    const fallback = await insertRule(f, { triggerType: "follow", templates: ["谢谢关注"], cooldownSeconds: 0, priority: 10 });
    const run = evaluator(f.tenantId, { viewerCooldownSeconds: 0 });
    await insertInteraction(f, { kind: "follow", text: "观众关注了直播间", viewer: "a" });
    await run.runOnce();
    await deliverAndAge(f);
    await insertInteraction(f, { kind: "follow", text: "观众关注了直播间", viewer: "b" });
    await run.runOnce();
    const rows = await firings(f);
    assert.deepEqual(rows.map((row) => [row.rule_id, row.outcome]), [[thanks, "speech_queued"], [fallback, "speech_queued"]]);
    const onlyRule = await fixture();
    await insertRule(onlyRule, { triggerType: "follow", templates: ["感谢关注"], cooldownSeconds: 3600 });
    const single = evaluator(onlyRule.tenantId, { viewerCooldownSeconds: 0 });
    await insertInteraction(onlyRule, { kind: "follow", text: "观众关注了直播间", viewer: "a" });
    await single.runOnce();
    await deliverAndAge(onlyRule);
    await insertInteraction(onlyRule, { kind: "follow", text: "观众关注了直播间", viewer: "b" });
    await single.runOnce();
    assert.deepEqual((await firings(onlyRule)).map((row) => row.outcome_reason), [null, "rule_cooldown"]);
  });

  test("the policy engine blocks a rendered line, with the run's profile terms, and records its hash without speaking", async () => {
    const f = await fixture();
    // Inserted as approved directly: the console approval check would have refused this template.
    await insertRule(f, { triggerType: "keyword", matchConfig: { keywords: ["发货"] }, templates: ["{product_name}全网最低价"] });
    await insertRule(f, { triggerType: "gift", matchConfig: { minGiftValueCents: 0 }, templates: ["感谢{nickname}的礼物，绝对安全"] });
    const run = evaluator(f.tenantId);
    await insertInteraction(f, { kind: "comment", text: "什么时候发货", viewer: "a" });
    await insertInteraction(f, { kind: "gift", text: "观众送出礼物", viewer: "b", nickname: "阿乙", giftValueCents: 100 });
    await run.runOnce();
    const rows = await firings(f);
    assert.deepEqual(rows.map((row) => row.outcome), ["policy_blocked", "policy_blocked"]);
    assert.equal(rows[0].rendered_text_sha256, sha256("氨基酸洁面慕斯全网最低价"));
    assert.match(rows[1].outcome_reason, /租户禁用词/);
    assert.equal((await speeches(f)).length, 0);
    const audit = await h.admin.query("select count(*)::int as count from audit_events where tenant_id = $1 and event_type = 'interaction_rule.policy_blocked'", [f.tenantId]);
    assert.equal(audit.rows[0].count, 2);
  });

  test("a nickname that fails the checks is spoken as a neutral address; a handed-off comment is never answered", async () => {
    const f = await fixture();
    await insertRule(f, { triggerType: "viewer_enter", templates: ["欢迎{nickname}"] });
    await insertRule(f, { triggerType: "keyword", matchConfig: { keywords: ["退"] }, templates: ["好的"] });
    await insertInteraction(f, { kind: "comment", text: "我要退款", policyAction: "handoff", viewer: "x" });
    await insertInteraction(f, { viewer: "a", nickname: "绝对安全哥" });
    await evaluator(f.tenantId).runOnce();
    const rows = await firings(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rendered_text_sha256, sha256(`欢迎${NEUTRAL_NICKNAME}`));
  });

  test("concurrent workers queue one line per trigger", async () => {
    const f = await fixture();
    await insertRule(f, { triggerType: "viewer_enter", templates: ["欢迎{nickname}"] });
    const interaction = await insertInteraction(f, { viewer: "a" });
    await Promise.all([evaluator(f.tenantId).runOnce(), evaluator(f.tenantId).runOnce(), evaluator(f.tenantId).runOnce()]);
    assert.equal((await speeches(f)).length, 1);
    assert.equal((await firings(f)).filter((row) => row.interaction_id === interaction).length, 1);
    await evaluator(f.tenantId).runOnce();
    assert.equal((await speeches(f)).length, 1);
  });

  test("a reply-draft rule creates a draft that still needs human approval", async () => {
    const f = await fixture();
    await insertRule(f, { triggerType: "keyword", action: "reply_draft", matchConfig: { keywords: ["发货"] }, templates: ["{nickname}您好，{product_name}的发货时间以订单页为准。"] });
    const interaction = await insertInteraction(f, { kind: "comment", text: "多久发货", viewer: "a", nickname: "阿甲" });
    await evaluator(f.tenantId).runOnce();
    const draft = (await h.admin.query("select d.status, d.body, d.policy_action, d.product_version_id, u.external_subject from channel_reply_drafts d join users u on u.id = d.created_by where d.interaction_id = $1", [interaction])).rows[0];
    assert.deepEqual(draft, { status: "draft", body: "阿甲您好，氨基酸洁面慕斯的发货时间以订单页为准。", policy_action: "answer", product_version_id: f.productVersionId, external_subject: "runtime-worker" });
    assert.equal((await firings(f))[0].outcome, "reply_drafted");
    assert.equal((await speeches(f)).length, 0);
  });

  test("a run without an approved policy profile, voice or current product speaks nothing", async () => {
    const f = await fixture();
    await insertRule(f, { triggerType: "viewer_enter", templates: ["欢迎{nickname}"] });
    await h.admin.query("update policy_profiles set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = 'integration' where tenant_id = $1", [f.tenantId, f.memberId]);
    await insertInteraction(f, { viewer: "a" });
    await evaluator(f.tenantId).runOnce();
    assert.deepEqual((await firings(f)).map((row) => [row.outcome, row.outcome_reason]), [["unavailable", "policy_profile_inactive"]]);
    assert.equal((await speeches(f)).length, 0);
  });
});

describe("database rules, row security and worker privileges", () => {
  const rejected = async (client, sql, params) => {
    await client.query("savepoint probe");
    try {
      await client.query(sql, params);
      return null;
    } catch (error) {
      return error.message;
    } finally {
      await client.query("rollback to savepoint probe");
    }
  };

  test("rules are retained, the AI disclosure stays enabled, content changes need re-approval, firings are append-only", async () => {
    const f = await fixture();
    const { created } = await consoleRules.createDefaultInteractionRules(f.context);
    const ai = created.find((rule) => rule.defaultKey === "ai_disclosure");
    const welcome = created.find((rule) => rule.defaultKey === "welcome");
    await consoleRules.approveInteractionRule(f.context, welcome.id);
    const client = await h.connectAs("control_plane");
    await h.withTenant(client, f.tenantId, async (c) => {
      assert.match(await rejected(c, "delete from interaction_rules where id = $1", [welcome.id]), /retained for audit/);
      assert.match(await rejected(c, "update interaction_rules set enabled = false where id = $1", [ai.id]), /cannot be disabled/);
      assert.match(await rejected(c, "update interaction_rules set templates = '[\"我是真人主播\"]'::jsonb, approval_status = 'pending' where id = $1", [ai.id]), /only the interval/);
      assert.equal(await rejected(c, "update interaction_rules set interval_seconds = 300 where id = $1", [ai.id]), null);
      assert.match(await rejected(c, "update interaction_rules set interval_seconds = 3600 where id = $1", [ai.id]), /check constraint/);
      assert.match(await rejected(c, "update interaction_rules set templates = '[\"欢迎\"]'::jsonb where id = $1", [welcome.id]), /return to pending approval/);
      assert.equal(await rejected(c, "update interaction_rules set templates = '[\"欢迎\"]'::jsonb, approval_status = 'pending', approved_by = null, approved_at = null where id = $1", [welcome.id]), null);
      assert.match(await rejected(c, "insert into interaction_rules (tenant_id, name, trigger_type, templates, action, approval_status, approved_by, approved_at, created_by) values ($1, 'x', 'follow', '[\"x\"]'::jsonb, 'speak', 'approved', $2, now(), $2)", [f.tenantId, f.memberId]), /created pending approval/);
      assert.match(await rejected(c, "insert into interaction_rules (tenant_id, name, trigger_type, templates, action, default_key, created_by) values ($1, 'x', 'timed', '[\"x\"]'::jsonb, 'speak', 'ai_disclosure', $2)", [f.tenantId, f.memberId]), /check constraint|duplicate key/);
    });
    await insertRule(f, { triggerType: "viewer_enter", templates: ["欢迎"] });
    await insertInteraction(f, { viewer: "z" });
    await evaluator(f.tenantId).runOnce();
    const firing = (await firings(f))[0];
    await h.withTenant(client, f.tenantId, async (c) => {
      assert.match(await rejected(c, "update interaction_rule_firings set outcome = 'suppressed' where id = $1", [firing.id]), /append-only/);
      assert.match(await rejected(c, "delete from interaction_rule_firings where id = $1", [firing.id]), /append-only/);
    });
    await client.end();
  });

  test("the worker sees only its tenant's rules and reads products only through interaction_rule_product_context", async () => {
    const a = await fixture();
    const b = await fixture();
    await insertRule(a, { triggerType: "viewer_enter", templates: ["欢迎"] });
    const client = await h.connectAs("runtime_worker");
    await h.withTenant(client, b.tenantId, async (c) => {
      assert.equal((await c.query("select count(*)::int as count from interaction_rules")).rows[0].count, 0);
      assert.deepEqual((await c.query("select * from interaction_rule_product_context($1::uuid, $2::uuid)", [b.tenantId, a.runId])).rows, [], "another tenant's run has no product context");
      assert.match(await rejected(c, "select * from interaction_rule_product_context($1::uuid, $2::uuid)", [a.tenantId, a.runId]), /active tenant transaction/);
      const context = (await c.query("select product_name, price_cent from interaction_rule_product_context($1::uuid, $2::uuid)", [b.tenantId, b.runId])).rows;
      assert.deepEqual(context, [{ product_name: "氨基酸洁面慕斯", price_cent: "9900" }]);
      for (const sql of ["select name from products", "select facts from product_versions", "select created_by from interaction_rules", "select name from policy_profiles", "select handled_by from live_interactions"]) {
        assert.match(await rejected(c, sql, []), /permission denied/, sql);
      }
      assert.match(await rejected(c, "update interaction_rules set enabled = false", []), /permission denied/);
      assert.match(await rejected(c, "delete from interaction_rule_firings", []), /permission denied/);
    });
    const channelAdapter = await h.connectAs("channel_adapter");
    await h.withTenant(channelAdapter, a.tenantId, async (c) => {
      assert.match(await rejected(c, "select * from interaction_rule_product_context($1::uuid, $2::uuid)", [a.tenantId, a.runId]), /permission denied/);
    });
    await channelAdapter.end();
    await client.end();
  });
});
