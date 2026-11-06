// Unit tests of the live interaction rules (migration 084): the runtime worker's evaluator functions
// (apps/runtime-worker/interaction-rules.mjs, which runs the shared apps/console/lib/shared/policy-engine.mjs), the console's rule validation and
// approval check (apps/console/lib/interaction-rules.ts), the console API in demo mode, and the channel adapter's
// viewer events. No database is involved; scripts/integration/interaction-rules.test.mjs covers the database path.
//
//   node --test scripts/test-interaction-rules.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import fc from "fast-check";
import * as rules from "../apps/runtime-worker/interaction-rules.mjs";
import { parseNormalizedEvent } from "../apps/channel-adapter/lib.mjs";
import { controlPlaneRequest } from "../apps/channel-adapter/webhook.mjs";

register("./lib/console-ts-loader.mjs", import.meta.url);
for (const name of ["DATABASE_URL", "CONTROL_PLANE_DEMO_MODE"]) delete process.env[name];
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
const consoleRules = await import("../apps/console/lib/interaction-rules.ts");
const routes = {
  list: await import("../apps/console/app/api/v1/interaction-rules/route.ts"),
  item: await import("../apps/console/app/api/v1/interaction-rules/[ruleId]/route.ts"),
  approve: await import("../apps/console/app/api/v1/interaction-rules/[ruleId]/approve/route.ts"),
  defaults: await import("../apps/console/app/api/v1/interaction-rules/defaults/route.ts")
};
const live = {
  list: await import("../apps/console/app/api/v1/live-runs/route.ts"),
  lifecycle: await import("../apps/console/app/api/v1/live-runs/[runId]/lifecycle/route.ts"),
  preflight: await import("../apps/console/app/api/v1/live-runs/[runId]/preflight/route.ts")
};

const rule = (overrides = {}) => rules.parseRule({ id: "00000000-0000-4000-8000-000000000001", name: "rule", trigger_type: "viewer_enter", match_config: {}, templates: ["欢迎{nickname}"], action: "speak", cooldown_seconds: 30, interval_seconds: null, priority: 100, default_key: null, ...overrides });
const interaction = (overrides = {}) => ({ id: "00000000-0000-4000-8000-0000000000aa", interaction_kind: "viewer_enter", question_text: "观众进入直播间", policy_action: "answer", viewer_ref: null, viewer_nickname: "小明", gift_value_cents: null, channel_connection_id: null, ...overrides });

describe("rule matching", () => {
  test("a viewer event matches only the rule of its kind", () => {
    assert.equal(rules.ruleMatchesInteraction(rule(), interaction()), true);
    assert.equal(rules.ruleMatchesInteraction(rule({ trigger_type: "follow" }), interaction()), false);
    assert.equal(rules.ruleMatchesInteraction(rule({ trigger_type: "follow" }), interaction({ interaction_kind: "follow" })), true);
  });
  test("a gift matches when it reaches the rule's minimum value", () => {
    const gift = rule({ trigger_type: "gift", match_config: { minGiftValueCents: 500 } });
    assert.equal(rules.ruleMatchesInteraction(gift, interaction({ interaction_kind: "gift", gift_value_cents: 499 })), false);
    assert.equal(rules.ruleMatchesInteraction(gift, interaction({ interaction_kind: "gift", gift_value_cents: "500" })), true);
    assert.equal(rules.ruleMatchesInteraction(rule({ trigger_type: "gift" }), interaction({ interaction_kind: "gift", gift_value_cents: 0 })), true);
  });
  test("keywords match normalized comment text, never a comment the policy engine did not clear", () => {
    const keyword = rule({ trigger_type: "keyword", match_config: { keywords: ["发 货", "ＳＩＺＥ"] } });
    assert.equal(rules.ruleMatchesInteraction(keyword, interaction({ interaction_kind: "comment", question_text: "什么时候发货呀" })), true);
    assert.equal(rules.ruleMatchesInteraction(keyword, interaction({ interaction_kind: "comment", question_text: "what size" })), true);
    assert.equal(rules.ruleMatchesInteraction(keyword, interaction({ interaction_kind: "comment", question_text: "价格多少" })), false);
    assert.equal(rules.ruleMatchesInteraction(keyword, interaction({ interaction_kind: "comment", question_text: "发货慢我要退款", policy_action: "handoff" })), false);
    assert.equal(rules.ruleMatchesInteraction(keyword, interaction({ interaction_kind: "viewer_enter", question_text: "发货" })), false);
  });
  test("stored rules outside the console's constraints are ignored", () => {
    assert.equal(rule({ templates: [] }), null);
    assert.equal(rule({ templates: ["{unknown} 欢迎"] }), null);
    assert.equal(rule({ trigger_type: "keyword", match_config: {} }), null);
    assert.equal(rule({ trigger_type: "timed", interval_seconds: null }), null);
    assert.equal(rule({ trigger_type: "timed", interval_seconds: 300, action: "reply_draft" }), null);
    assert.equal(rule({ trigger_type: "nonsense" }), null);
  });
});

describe("template rendering and rotation", () => {
  test("slots are filled in one pass, so a slot value is never expanded again", () => {
    assert.deepEqual(rules.renderTemplate("欢迎{nickname}，{product_name} 只要 {price} 元", { nickname: "{price}", product_name: "洁面慕斯", price: "99.00" }), { text: "欢迎{price}，洁面慕斯 只要 99.00 元", missing: [] });
    assert.deepEqual(rules.renderTemplate("看看{product_name}", {}), { text: "看看{product_name}", missing: ["product_name"] });
    assert.equal(rules.formatPrice(9900), "99.00");
    assert.equal(rules.formatPrice(-1), null);
  });
  test("templates rotate at random and never repeat the last one when there is another", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 0, max: 9 }), fc.double({ min: 0, max: 1, noNaN: true }), (count, last, value) => {
      const lastIndex = last % count;
      const index = rules.chooseTemplateIndex(count, lastIndex, () => value);
      assert.ok(index >= 0 && index < count);
      assert.notEqual(index, lastIndex);
    }), { numRuns: 500 });
    assert.equal(rules.chooseTemplateIndex(1, 0, () => 0.5), 0);
    const seen = new Set(Array.from({ length: 200 }, () => rules.chooseTemplateIndex(4, 1)));
    assert.deepEqual([...seen].sort(), [0, 2, 3]);
  });
  test("console template validation accepts only the three slots", () => {
    assert.equal(consoleRules.isValidTemplate("欢迎{nickname}"), true);
    assert.equal(consoleRules.isValidTemplate("欢迎{name}"), false);
    assert.equal(consoleRules.isValidTemplate("欢迎{nickname"), false);
    assert.equal(consoleRules.isValidTemplate("x".repeat(201)), false);
    assert.equal(rules.isValidTemplate("欢迎{name}"), false);
  });
});

describe("nickname sanitization", () => {
  test("control, format and zero-width characters, symbols and markup are removed and the length is capped", () => {
    assert.deepEqual(rules.sanitizeNickname("小\u0000明\u200B\u202E", [], 12), { nickname: "小明", neutral: false });
    assert.deepEqual(rules.sanitizeNickname("  Lily🌸 {nickname} <b> ", [], 12), { nickname: "Lily nicknam", neutral: false });
    assert.equal(rules.sanitizeNickname("一二三四五六七八九十甲乙丙丁", [], 12).nickname, "一二三四五六七八九十甲乙");
  });
  test("links, contact details, impersonation, policy terms and empty names fall back to a neutral address", () => {
    for (const [raw, reason] of [["加我微信abc", "contact_or_link"], ["www.example.com", "contact_or_link"], ["13800138000", "contact_or_link"], ["官方客服", "impersonation"], ["退款大王", "policy"], ["🌸🌸", "empty"], ["\u200B", "empty"]]) {
      assert.deepEqual(rules.sanitizeNickname(raw, []), { nickname: rules.NEUTRAL_NICKNAME, neutral: true, reason }, raw);
    }
    assert.equal(rules.sanitizeNickname(undefined).reason, "missing");
    assert.equal(rules.sanitizeNickname("绝对安全哥", [{ id: "x", terms: ["绝对安全"], reason: "租户禁用词", action: "refuse", riskLevel: "high", requiredEvidence: [] }]).neutral, true);
  });
  test("a sanitized nickname is short and free of control characters and braces", () => {
    fc.assert(fc.property(fc.string({ maxLength: 80, unit: "binary" }), (raw) => {
      const { nickname } = rules.sanitizeNickname(raw, [], 12);
      assert.ok(Array.from(nickname).length <= 12);
      assert.ok(!/[\p{Cc}\p{Cf}{}<>]/u.test(nickname));
    }), { numRuns: 500 });
  });
});

describe("cooldowns and rate limits", () => {
  const run = { pending_program_transition_event_id: null, pending_media_event_id: null, scheduled_start_event_id: null };
  const gate = (overrides) => rules.speechGateReason({ run, pendingSpeech: false, pendingMedia: false, lastSpeechAgeSeconds: null, minSpeechIntervalSeconds: 30, spokenThisPass: false, ...overrides });
  test("automatic speech waits for program transitions, pending commands, the global interval and the pass budget", () => {
    assert.equal(gate({}), null);
    assert.equal(gate({ lastSpeechAgeSeconds: 31 }), null);
    assert.equal(gate({ lastSpeechAgeSeconds: 10 }), "global_speech_interval");
    assert.equal(gate({ pendingSpeech: true }), "speech_pending");
    assert.equal(gate({ pendingMedia: true }), "media_command_pending");
    assert.equal(gate({ run: { ...run, pending_program_transition_event_id: "x" } }), "program_transition_pending");
    assert.equal(gate({ run: { ...run, scheduled_start_event_id: "x" } }), "program_transition_pending");
    assert.equal(gate({ spokenThisPass: true }), "speech_budget_used");
  });
  test("timer slots and cooldown buckets: two firings in one bucket are always closer than the cooldown", () => {
    assert.equal(rules.timerSlot(1_200, 600), 2);
    assert.equal(rules.timerSlot(1_199, 600), 1);
    assert.equal(rules.cooldownBucket(100, 0), null);
    fc.assert(fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 86_400 }), (start, gap, cooldown) => {
      if (rules.cooldownBucket(start, cooldown) === rules.cooldownBucket(start + gap, cooldown)) assert.ok(gap < cooldown);
    }), { numRuns: 500 });
    assert.equal(rules.effectiveCooldownSeconds(rule({ trigger_type: "timed", interval_seconds: 600, cooldown_seconds: 0 })), 300);
    assert.equal(rules.effectiveCooldownSeconds(rule({ cooldown_seconds: 45 })), 45);
  });
  test("worker settings are bounded", () => {
    assert.deepEqual(rules.interactionRuleConfig({}), { enabled: true, pollMs: 2000, minSpeechIntervalSeconds: 30, viewerCooldownSeconds: 600, maxEventAgeSeconds: 60, batchSize: 20, nicknameMaxLength: 12 });
    assert.equal(rules.interactionRuleConfig({ INTERACTION_RULES_ENABLED: "false" }).enabled, false);
    for (const env of [{ INTERACTION_RULE_MIN_SPEECH_INTERVAL_SECONDS: "1" }, { INTERACTION_RULE_POLL_MS: "abc" }, { INTERACTION_RULES_ENABLED: "yes" }, { INTERACTION_RULE_BATCH_SIZE: "1.5" }]) assert.throws(() => rules.interactionRuleConfig(env), /must be/);
  });
});

describe("policy interception and product facts", () => {
  test("the rendered line must be an answer decision of the policy engine", () => {
    assert.equal(rules.checkRenderedText("欢迎小明来到直播间", [], 800).allowed, true);
    assert.equal(rules.checkRenderedText("现在下单有赠品哦", [], 800).allowed, true, "a product fact line is answerable with the frozen product version as evidence");
    const blocked = rules.checkRenderedText("全网最低价洁面慕斯", [], 800);
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.reasons, ["价格或营销承诺", "缺少必要证据"]);
    assert.equal(rules.checkRenderedText("这款绝对安全", [{ id: "x", terms: ["绝对安全"], reason: "租户禁用词", action: "refuse", riskLevel: "high", requiredEvidence: [] }], 800).allowed, false);
    assert.equal(rules.checkRenderedText("长".repeat(801), [], 800).allowed, false);
  });
  test("product facts must be current like the console's isProductFactsCurrent", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    const product = { source_ref: "pim://x", source_synced_at: "2026-11-01T11:00:00Z", valid_from: "2026-11-01T00:00:00Z", valid_until: null };
    assert.equal(rules.isProductContextCurrent(product, now), true);
    assert.equal(rules.isProductContextCurrent({ ...product, source_synced_at: "2026-10-30T11:00:00Z" }, now), false);
    assert.equal(rules.isProductContextCurrent({ ...product, valid_until: "2026-11-01T11:59:00Z" }, now), false);
    assert.equal(rules.isProductContextCurrent({ ...product, source_ref: " " }, now), false);
  });
  test("speech command ids from firing ids satisfy the speech protocol", () => {
    const id = rules.speechCommandId("3f1a2b3c-0000-4000-8000-0000000000ab");
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  });
});

describe("console rule validation and approval", () => {
  const input = (overrides = {}) => consoleRules.parseInteractionRuleInput({ name: "欢迎", triggerType: "viewer_enter", action: "speak", templates: ["欢迎{nickname}"], ...overrides });
  test("create input parsing and cross-field rules", () => {
    assert.equal(input().cooldownSeconds, 60);
    assert.equal(input({ triggerType: "timed", templates: ["介绍{product_name}"], intervalSeconds: 300 }).cooldownSeconds, 0);
    assert.equal(input({ extra: true }), null);
    assert.equal(input({ liveRunId: "run_1" }), null);
    assert.equal(consoleRules.ruleShapeError(input()), null);
    assert.match(consoleRules.ruleShapeError(input({ triggerType: "timed", intervalSeconds: 300 })), /不能使用 \{nickname\}/);
    assert.match(consoleRules.ruleShapeError(input({ triggerType: "timed", templates: ["介绍{product_name}"] })), /间隔/);
    assert.match(consoleRules.ruleShapeError(input({ triggerType: "keyword" })), /关键词/);
    assert.match(consoleRules.ruleShapeError(input({ triggerType: "timed", templates: ["x"], intervalSeconds: 300, action: "reply_draft" })), /只能语音播报/);
    assert.match(consoleRules.ruleShapeError(input({ priority: 1000 })), /优先级/);
    assert.match(consoleRules.ruleShapeError(input({ templates: ["欢迎{name}"] })), /槽位/);
  });
  test("every default template passes the approval policy check, and a risky template does not", () => {
    for (const preset of consoleRules.defaultInteractionRules) {
      assert.deepEqual(consoleRules.templatePolicyFailures(preset.templates, []), [], preset.name);
      assert.equal(consoleRules.ruleShapeError({ ...preset, enabled: true }), null, preset.name);
      assert.ok(rules.parseRule({ id: "x", name: preset.name, trigger_type: preset.triggerType, match_config: preset.matchConfig, templates: preset.templates, action: preset.action, cooldown_seconds: preset.cooldownSeconds, interval_seconds: preset.intervalSeconds ?? null, priority: preset.priority, default_key: preset.defaultKey }), preset.name);
    }
    const failures = consoleRules.templatePolicyFailures(["欢迎{nickname}", "全网最低价，{product_name}"], []);
    assert.deepEqual(failures.map((failure) => failure.index), [1]);
    const ai = consoleRules.defaultInteractionRules.find((preset) => preset.defaultKey === "ai_disclosure");
    assert.equal(ai.intervalSeconds, 600);
    assert.equal(ai.priority, 1000);
    assert.ok(ai.templates.every((template) => template.includes("AI")));
  });
});

describe("console API (demo mode)", () => {
  const headers = (role) => ({ "x-tenant-id": `tenant_rules_${role}`, "x-actor-id": `actor-${role}`, "x-actor-name": "Rules Check", "x-actor-role": role, "content-type": "application/json" });
  const call = async (handler, url, { method = "GET", role = "admin", body, params = {} } = {}) => {
    const response = await handler(new Request(`http://127.0.0.1${url}`, { method, headers: headers(role), body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve(params) });
    return { status: response.status, body: await response.json() };
  };
  test("defaults are created once, pending approval, and approval runs the policy check", async () => {
    const first = await call(routes.defaults.POST, "/api/v1/interaction-rules/defaults", { method: "POST" });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.created.length, 5);
    assert.ok(first.body.data.created.every((created) => created.approval === "pending"));
    const second = await call(routes.defaults.POST, "/api/v1/interaction-rules/defaults", { method: "POST" });
    assert.deepEqual([second.status, second.body.data.created.length, second.body.data.existing], [200, 0, 5]);
    const ai = first.body.data.created.find((created) => created.defaultKey === "ai_disclosure");
    const approved = await call(routes.approve.POST, "/approve", { method: "POST", params: { ruleId: ai.id } });
    assert.equal(approved.body.data.approval, "approved");
    const again = await call(routes.approve.POST, "/approve", { method: "POST", params: { ruleId: ai.id } });
    assert.equal(again.status, 409);
  });
  test("the AI identity disclosure cannot be disabled and only its interval can change", async () => {
    const listed = await call(routes.list.GET, "/api/v1/interaction-rules");
    const ai = listed.body.data.find((item) => item.defaultKey === "ai_disclosure");
    const disabled = await call(routes.item.DELETE, "/x", { method: "DELETE", params: { ruleId: ai.id } });
    assert.deepEqual([disabled.status, disabled.body.error], [409, "ai_disclosure_rule_protected"]);
    const renamed = await call(routes.item.PATCH, "/x", { method: "PATCH", params: { ruleId: ai.id }, body: { templates: ["我是真人"] } });
    assert.deepEqual([renamed.status, renamed.body.error], [409, "ai_disclosure_rule_protected"]);
    const tooRare = await call(routes.item.PATCH, "/x", { method: "PATCH", params: { ruleId: ai.id }, body: { intervalSeconds: 3600 } });
    assert.equal(tooRare.status, 422);
    const interval = await call(routes.item.PATCH, "/x", { method: "PATCH", params: { ruleId: ai.id }, body: { intervalSeconds: 300 } });
    assert.deepEqual([interval.status, interval.body.data.intervalSeconds, interval.body.data.approval], [200, 300, "approved"], "an interval change keeps the approval");
  });
  test("a blocked template refuses approval; a content change returns the rule to pending", async () => {
    const created = await call(routes.list.POST, "/api/v1/interaction-rules", { method: "POST", body: { name: "促销", triggerType: "timed", action: "speak", templates: ["全网最低价的{product_name}"], intervalSeconds: 600 } });
    assert.equal(created.status, 201);
    const refused = await call(routes.approve.POST, "/approve", { method: "POST", params: { ruleId: created.body.data.id } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, "interaction_rule_template_policy_blocked");
    assert.deepEqual(refused.body.failures.map((failure) => failure.index), [0]);
    const fixed = await call(routes.item.PATCH, "/x", { method: "PATCH", params: { ruleId: created.body.data.id }, body: { templates: ["正在介绍{product_name}，当前价格{price}元"] } });
    assert.equal(fixed.body.data.approval, "pending");
    const approved = await call(routes.approve.POST, "/approve", { method: "POST", params: { ruleId: created.body.data.id } });
    assert.equal(approved.body.data.approval, "approved");
    const changed = await call(routes.item.PATCH, "/x", { method: "PATCH", params: { ruleId: created.body.data.id }, body: { templates: ["介绍{product_name}"] } });
    assert.equal(changed.body.data.approval, "pending");
    const disabled = await call(routes.item.DELETE, "/x", { method: "DELETE", params: { ruleId: created.body.data.id } });
    assert.equal(disabled.body.data.enabled, false);
  });
  test("roles: analysts read, operators cannot approve, reviewers cannot create", async () => {
    assert.equal((await call(routes.list.GET, "/api/v1/interaction-rules", { role: "analyst" })).status, 200);
    assert.deepEqual(await call(routes.list.POST, "/api/v1/interaction-rules", { method: "POST", role: "reviewer", body: {} }), { status: 403, body: { error: "interaction_rule_rejected" } });
    assert.deepEqual(await call(routes.approve.POST, "/approve", { method: "POST", role: "operator", params: { ruleId: "x" } }), { status: 403, body: { error: "interaction_rule_approval_rejected" } });
    assert.equal((await call(routes.list.POST, "/api/v1/interaction-rules", { method: "POST", body: { name: "x" } })).status, 400);
  });
});

// Module A (live-commerce-p1-features, Requirement 1.2, 1.3, 1.5, 1.9): in demo mode the preflight reads the in-memory
// rule store of the run's tenant and never injects an approved AI disclosure rule. The tenant is dedicated to this block,
// so the "five default rules on first creation" assertions above stay valid whatever the test order.
describe("demo-mode AI disclosure preflight", () => {
  const tenantId = "tenant_rules_preflight";
  const runId = "00000000-0000-4000-8000-0000000000f1"; // telemetry lookups require a UUID run id, also in demo mode
  const blockedDetail = {
    missing: "未创建 AI 身份提示规则（在\"互动规则\"页一键创建默认规则并审批）",
    pending: "AI 身份提示规则待审批"
  };
  const headers = { "x-tenant-id": tenantId, "x-actor-id": "actor-preflight", "x-actor-name": "Preflight Check", "x-actor-role": "admin", "content-type": "application/json" };
  const call = async (handler, url, { method = "GET", body, params = {} } = {}) => {
    const response = await handler(new Request(`http://127.0.0.1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve(params) });
    return { status: response.status, body: await response.json() };
  };
  const arm = () => call(live.lifecycle.POST, "/lifecycle", { method: "POST", body: { action: "arm" }, params: { runId } });
  const aiCheck = async () => {
    const preflight = await call(live.preflight.GET, "/preflight", { params: { runId } });
    assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
    const checks = preflight.body.data.checks;
    assert.deepEqual(checks.map((check) => check.id).filter((id) => id === "disclosure" || id === "ai_disclosure_rule" || id === "aigc_label"), ["disclosure", "ai_disclosure_rule", "aigc_label"]);
    return { check: checks.find((check) => check.id === "ai_disclosure_rule"), blocked: checks.filter((check) => check.status === "blocked").map((check) => check.id) };
  };

  test("arm is refused without a rule and while it is pending; approving it clears only the ai_disclosure_rule check", async () => {
    // Initialize the demo control store through the public route, then add a PREFLIGHT run for the dedicated tenant.
    assert.equal((await call(live.list.GET, "/api/v1/live-runs")).status, 200);
    globalThis.shuzhirenControlStore.runs.set(runId, {
      id: runId, tenantId, revisionId: "show_revision_rules_preflight", channelConnectionId: "channel_demo", productVersionId: "pv_a102_v1", showName: "AI disclosure preflight",
      state: "PREFLIGHT", traceId: runId, hasOperator: true, hasApprovedRights: true, hasApprovedSkuVersion: true, hasFallbackProgram: true, channelReady: true,
      outputReady: false, aiDisclosureEnabled: true, commandHistory: [], questions: []
    });
    try {
      assert.deepEqual((await consoleRules.aiDisclosureRuleStatus({ tenantId })), { passed: false, detail: blockedDetail.missing }, "no fixture rule is injected");
      let state = await aiCheck();
      const blockedWithoutRule = state.blocked;
      assert.deepEqual([state.check.status, state.check.detail], ["blocked", blockedDetail.missing]);
      assert.ok(blockedWithoutRule.includes("ai_disclosure_rule"));
      const refused = await arm();
      assert.equal(refused.status, 409);
      assert.equal(globalThis.shuzhirenControlStore.runs.get(runId).state, "PREFLIGHT", "a refused arm leaves the run in PREFLIGHT");

      const created = await call(routes.defaults.POST, "/api/v1/interaction-rules/defaults", { method: "POST" });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.created.length, 5);
      state = await aiCheck();
      assert.deepEqual([state.check.status, state.check.detail], ["blocked", blockedDetail.pending]);
      const stillRefused = await arm();
      assert.equal(stillRefused.status, 409);
      assert.equal(globalThis.shuzhirenControlStore.runs.get(runId).state, "PREFLIGHT");

      const ai = created.body.data.created.find((rule) => rule.defaultKey === "ai_disclosure");
      const approved = await call(routes.approve.POST, "/approve", { method: "POST", params: { ruleId: ai.id } });
      assert.equal(approved.body.data.approval, "approved");
      state = await aiCheck();
      assert.equal(state.check.status, "passed");
      assert.match(state.check.detail, /600/, "the detail carries the interval in seconds");
      assert.ok(!state.blocked.includes("ai_disclosure_rule"), "arm is no longer refused because of the AI disclosure rule");
      assert.deepEqual(state.blocked, blockedWithoutRule.filter((id) => id !== "ai_disclosure_rule"), "approving the rule clears only that check");
      // Other checks (rights, releases, channel, output ...) stay blocked in demo mode, so arm is still 409, now for those checks only.
      assert.equal((await arm()).status, 409);
    } finally {
      globalThis.shuzhirenControlStore.runs.delete(runId);
    }
  });
});

// Feature: live-commerce-p1-features, Property 1: AI 身份口播规则判定
// For any row | null, evaluateAiDisclosureRule(row).passed holds exactly when the rule exists, is enabled, is approved,
// is tenant-level (live_run_id null), is timed + speak and its interval is an integer in [60, 1800]. detail is never empty.
// **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
describe("Property 1: AI disclosure rule evaluation", () => {
  const uuid = fc.uuid();
  const rowArbitrary = fc.record({
    enabled: fc.boolean(),
    approval_status: fc.oneof({ weight: 4, arbitrary: fc.constant("approved") }, { weight: 2, arbitrary: fc.constant("pending") }, { weight: 1, arbitrary: fc.string({ maxLength: 12 }) }),
    live_run_id: fc.oneof({ weight: 4, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: uuid }),
    trigger_type: fc.oneof({ weight: 4, arbitrary: fc.constant("timed") }, { weight: 2, arbitrary: fc.constantFrom("viewer_enter", "follow", "gift", "keyword", "faq") }, { weight: 1, arbitrary: fc.string({ maxLength: 12 }) }),
    action: fc.oneof({ weight: 4, arbitrary: fc.constant("speak") }, { weight: 1, arbitrary: fc.constant("reply_draft") }, { weight: 1, arbitrary: fc.string({ maxLength: 12 }) }),
    interval_seconds: fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(59, 60, 1800, 1801) },
      { weight: 3, arbitrary: fc.integer({ min: 60, max: 1800 }) },
      { weight: 2, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
      { weight: 1, arbitrary: fc.constant(null) },
      { weight: 2, arbitrary: fc.double({ min: 0, max: 2000, noNaN: true }) }
    )
  });
  const expectedPassed = (row) => row !== null && row.enabled === true && row.approval_status === "approved" && row.live_run_id === null
    && row.trigger_type === "timed" && row.action === "speak" && Number.isInteger(row.interval_seconds) && row.interval_seconds >= 60 && row.interval_seconds <= 1800;

  test("passes if and only if the design postcondition holds, and always explains the result", () => {
    let passedCount = 0;
    fc.assert(fc.property(fc.oneof({ weight: 1, arbitrary: fc.constant(null) }, { weight: 9, arbitrary: rowArbitrary }), (row) => {
      const result = consoleRules.evaluateAiDisclosureRule(row);
      assert.equal(result.passed, expectedPassed(row), JSON.stringify(row));
      assert.equal(typeof result.detail, "string");
      assert.ok(result.detail.length > 0, "detail is never empty");
      if (result.passed) passedCount += 1;
    }), { numRuns: 1000, seed: 20250101 });
    assert.ok(passedCount > 0, "the generator reaches the passing region");
  });

  test("interval boundaries 59, 60, 1800 and 1801 on an otherwise valid rule", () => {
    const valid = { enabled: true, approval_status: "approved", live_run_id: null, trigger_type: "timed", action: "speak", interval_seconds: 600 };
    const passes = (overrides) => consoleRules.evaluateAiDisclosureRule({ ...valid, ...overrides }).passed;
    assert.deepEqual([59, 60, 1800, 1801, 60.5, null].map((interval_seconds) => passes({ interval_seconds })), [false, true, true, false, false, false]);
    assert.equal(passes({}), true);
  });
});

// Feature: live-commerce-p1-features, Property 2: 口播规则未就绪必然阻止开播
// With every other input in its passing state, aiDisclosureRuleReady = false makes evaluatePreflight fail with a blocked
// ai_disclosure_rule check whose detail is exactly the supplied text; aiDisclosureRuleReady = true makes that check passed.
// **Validates: Requirements 1.1, 1.6**
const { evaluatePreflight } = await import("../apps/console/lib/control-plane/preflight.ts");
describe("Property 2: an unready AI disclosure rule always blocks preflight", () => {
  const passingInputs = {
    hasApprovedRights: true, rightsDetail: "rights ok", hasApprovedModelReleases: true, modelReleaseDetail: "releases ok",
    hasApprovedPolicyProfile: true, policyProfileDetail: "policy ok", hasOperator: true, hasApprovedSkuVersion: true, skuDetail: "sku ok",
    hasFallbackProgram: true, channelReady: true, channelDetail: "channel ok", outputReady: true, outputDetail: "output ok",
    runtimeSessionReady: true, runtimeSessionDetail: "session ok", aiDisclosureEnabled: true, aiDisclosureRuleReady: true,
    aiDisclosureRuleDetail: "rule ok", aigcLabelReady: true, aigcLabelDetail: "label ok"
  };
  const detailArbitrary = fc.oneof(fc.string({ minLength: 1, maxLength: 80 }), fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 })).filter((text) => text.length > 0);

  test("aiDisclosureRuleReady = false => passed is false and the rule check is blocked with the input detail", () => {
    fc.assert(fc.property(detailArbitrary, (aiDisclosureRuleDetail) => {
      const result = evaluatePreflight({ ...passingInputs, aiDisclosureRuleReady: false, aiDisclosureRuleDetail });
      const check = result.checks.find((item) => item.id === "ai_disclosure_rule");
      assert.equal(result.passed, false);
      assert.ok(check, "the ai_disclosure_rule check is present");
      assert.equal(check.status, "blocked");
      assert.equal(check.detail, aiDisclosureRuleDetail);
      assert.deepEqual(result.checks.filter((item) => item.status === "blocked").map((item) => item.id), ["ai_disclosure_rule"], "no other check is affected");
    }), { numRuns: 200, seed: 20250102 });
  });

  test("aiDisclosureRuleReady = true => the rule check is passed and, with everything else passing, so is the preflight", () => {
    fc.assert(fc.property(detailArbitrary, (aiDisclosureRuleDetail) => {
      const result = evaluatePreflight({ ...passingInputs, aiDisclosureRuleReady: true, aiDisclosureRuleDetail });
      const check = result.checks.find((item) => item.id === "ai_disclosure_rule");
      assert.ok(check, "the ai_disclosure_rule check is present");
      assert.equal(check.status, "passed");
      assert.equal(check.detail, aiDisclosureRuleDetail);
      assert.equal(result.passed, true);
    }), { numRuns: 200, seed: 20250103 });
  });
});

describe("channel adapter viewer events", () => {
  const target = { tenantId: "t", channelConnectionId: "c", interactionToken: "interaction-token", commerceToken: "commerce-token" };
  test("viewer events are parsed and forwarded on the interaction ingest path", () => {
    assert.deepEqual(parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "viewer_enter", viewerId: "u1", viewerNickname: "小明" }), { kind: "viewer_event", runId: "run_1", eventType: "viewer_enter", viewerId: "u1", viewerNickname: "小明" });
    assert.deepEqual(parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "gift", giftValueCents: 100 }), { kind: "viewer_event", runId: "run_1", eventType: "gift", giftValueCents: 100 });
    assert.throws(() => parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "gift" }), /Invalid giftValueCents/);
    assert.throws(() => parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "follow", giftValueCents: 1 }), /Invalid giftValueCents/);
    assert.throws(() => parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "share" }), /Unsupported viewer event type/);
    assert.throws(() => parseNormalizedEvent({ kind: "viewer_event", runId: "run_1", eventType: "follow", viewerNickname: "x".repeat(65) }), /Invalid viewerNickname/);
    assert.deepEqual(parseNormalizedEvent({ kind: "interaction", runId: "run_1", question: "发货吗", viewerNickname: "小红" }), { kind: "interaction", runId: "run_1", question: "发货吗", viewerNickname: "小红" });
    assert.deepEqual(controlPlaneRequest({ target, eventId: "e1", event: { kind: "viewer_event", runId: "run_1", eventType: "gift", viewerId: "u1", giftValueCents: 100 } }), { path: "/api/v1/runtime/channel-interactions", token: "interaction-token", body: { tenantId: "t", channelConnectionId: "c", eventId: "e1", runId: "run_1", interactionKind: "gift", viewerId: "u1", giftValueCents: 100 } });
    assert.deepEqual(controlPlaneRequest({ target, eventId: "e2", event: { kind: "interaction", runId: "run_1", question: "q" } }).body, { tenantId: "t", channelConnectionId: "c", eventId: "e2", runId: "run_1", question: "q" }, "a comment without viewer fields keeps its original body");
  });
});
