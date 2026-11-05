import type { PoolClient } from "pg";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { evaluatePolicy, type PolicyDecision, type PolicyRule } from "@/lib/policy-engine";
import { latestApprovedPolicyProfile } from "@/lib/policy-profiles";

// Live interaction rules (migration 084). The console manages and approves rules; apps/runtime-worker/
// interaction-rules.mjs evaluates approved, enabled rules during LIVE runs and queues their lines through the
// existing speech.dispatch outbox or as channel reply drafts. Approval runs every template through the policy
// engine; the worker checks the rendered line again with the run's bound policy profile.

export type InteractionRuleTrigger = "viewer_enter" | "follow" | "gift" | "keyword" | "timed" | "idle_comment";
export type InteractionRuleAction = "speak" | "reply_draft";
export type InteractionRuleApproval = "pending" | "approved";
export type InteractionRuleDefaultKey = "welcome" | "follow_thanks" | "gift_thanks" | "timed_product" | "ai_disclosure";
export type InteractionRuleMatchConfig = { keywords?: string[]; minGiftValueCents?: number };
export type InteractionRule = {
  id: string; tenantId: string; liveRunId?: string; name: string; triggerType: InteractionRuleTrigger; matchConfig: InteractionRuleMatchConfig;
  templates: string[]; action: InteractionRuleAction; cooldownSeconds: number; intervalSeconds?: number; priority: number; enabled: boolean;
  defaultKey?: InteractionRuleDefaultKey; approval: InteractionRuleApproval; approvedAt?: string; createdAt: string; updatedAt: string;
};
export type InteractionRuleInput = {
  name: string; triggerType: InteractionRuleTrigger; matchConfig: InteractionRuleMatchConfig; templates: string[]; action: InteractionRuleAction;
  cooldownSeconds: number; intervalSeconds?: number; priority: number; enabled: boolean; liveRunId?: string;
};
export type InteractionRulePatch = Partial<Omit<InteractionRuleInput, "liveRunId">> & { liveRunId?: string | null };
export type InteractionRuleFiringOutcome = "speech_queued" | "reply_drafted" | "policy_blocked" | "suppressed" | "unavailable";
export type InteractionRuleFiring = {
  id: string; ruleId: string; ruleName: string; runId: string; interactionId?: string; triggerKey: string; templateIndex?: number;
  renderedTextSha256?: string; outcome: InteractionRuleFiringOutcome; outcomeReason?: string; outboxEventId?: string; createdAt: string;
};
export type TemplatePolicyFailure = { index: number; text: string; decision: PolicyDecision["action"]; reasons: string[] };

export const interactionRuleTriggers: InteractionRuleTrigger[] = ["viewer_enter", "follow", "gift", "keyword", "timed", "idle_comment"];
export const timerTriggers: InteractionRuleTrigger[] = ["timed", "idle_comment"];
export const templateSlots = ["nickname", "product_name", "price"] as const;
// Values used to render templates for the approval check; the worker renders with the run's real values and
// checks the result again.
export const approvalSampleSlots: Record<(typeof templateSlots)[number], string> = { nickname: "这位朋友", product_name: "示例商品", price: "99.00" };
export const aiDisclosureIntervalBounds = { min: 60, max: 1800 } as const;
export const maxTemplateLength = 200;

type DefaultRule = Omit<InteractionRuleInput, "liveRunId" | "enabled"> & { defaultKey: InteractionRuleDefaultKey };
// "Create default rules" inserts these per tenant (once per key, pending approval). They are code, not global
// seed data. The AI identity disclosure is the spoken part of AIGC labelling: it cannot be disabled and only its
// interval can change.
export const defaultInteractionRules: DefaultRule[] = [
  { defaultKey: "welcome", name: "欢迎进场", triggerType: "viewer_enter", matchConfig: {}, action: "speak", cooldownSeconds: 30, priority: 100, templates: ["欢迎{nickname}来到直播间，喜欢可以点个关注。", "欢迎{nickname}，今天给大家介绍{product_name}，有问题可以打在公屏上。", "{nickname}来啦，欢迎欢迎，先看看我们的{product_name}吧。"] },
  { defaultKey: "follow_thanks", name: "感谢关注", triggerType: "follow", matchConfig: {}, action: "speak", cooldownSeconds: 30, priority: 200, templates: ["感谢{nickname}的关注！", "谢谢{nickname}关注直播间，后面还有更多讲解。"] },
  { defaultKey: "gift_thanks", name: "礼物答谢", triggerType: "gift", matchConfig: { minGiftValueCents: 0 }, action: "speak", cooldownSeconds: 15, priority: 300, templates: ["感谢{nickname}送的礼物，谢谢支持！", "谢谢{nickname}的礼物，祝你购物愉快。"] },
  { defaultKey: "timed_product", name: "定时商品口播", triggerType: "timed", matchConfig: {}, action: "speak", cooldownSeconds: 0, intervalSeconds: 300, priority: 400, templates: ["正在为大家介绍{product_name}，当前价格{price}元，具体以下单页为准。", "喜欢{product_name}的朋友可以看看购物车，当前价格{price}元，以结算页为准。"] },
  { defaultKey: "ai_disclosure", name: "AI 身份提示", triggerType: "timed", matchConfig: {}, action: "speak", cooldownSeconds: 0, intervalSeconds: 600, priority: 1000, templates: ["温馨提示：我是AI数字人主播，本场直播内容由人工智能生成。", "温馨提示：当前主播为AI数字人，商品信息以页面展示为准。"] }
];

export class TemplatePolicyError extends Error {
  failures: TemplatePolicyFailure[];
  constructor(failures: TemplatePolicyFailure[]) { super("Interaction rule templates are blocked by the policy engine"); this.failures = failures; }
}

type RuleStore = { rules: Map<string, InteractionRule> };
declare global { var shuzhirenInteractionRuleStore: RuleStore | undefined; }
function ruleStore() { globalThis.shuzhirenInteractionRuleStore ??= { rules: new Map() }; return globalThis.shuzhirenInteractionRuleStore; }

type PersistentRuleRow = {
  id: string; tenant_id: string; live_run_id: string | null; name: string; trigger_type: InteractionRuleTrigger; match_config: unknown; templates: unknown;
  action: InteractionRuleAction; cooldown_seconds: number; interval_seconds: number | null; priority: number; enabled: boolean; default_key: InteractionRuleDefaultKey | null;
  approval_status: InteractionRuleApproval; approved_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
};
type PersistentFiringRow = {
  id: string; rule_id: string; rule_name: string; live_run_id: string; interaction_id: string | null; trigger_key: string; template_index: number | null;
  rendered_text_sha256: string | null; outcome: InteractionRuleFiringOutcome; outcome_reason: string | null; outbox_event_id: string | null; created_at: Date | string;
};
const columns = "id, tenant_id, live_run_id, name, trigger_type, match_config, templates, action, cooldown_seconds, interval_seconds, priority, enabled, default_key, approval_status, approved_at, created_at, updated_at";

// ---- Validation (shared by the routes, the service functions and scripts/test-interaction-rules.mjs) ----

/** Parses a create request; returns null when a field has the wrong type. Cross-field rules: ruleShapeError. */
export function parseInteractionRuleInput(value: unknown): InteractionRuleInput | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["name", "triggerType", "matchConfig", "templates", "action", "cooldownSeconds", "intervalSeconds", "priority", "enabled", "liveRunId"].includes(key))) return null;
  if (typeof value.name !== "string" || !interactionRuleTriggers.includes(value.triggerType as InteractionRuleTrigger) || !["speak", "reply_draft"].includes(value.action as string)) return null;
  const matchConfig = parseMatchConfig(value.matchConfig ?? {});
  const templates = parseTemplates(value.templates);
  if (!matchConfig || !templates) return null;
  if (!optionalInteger(value.cooldownSeconds) || !optionalInteger(value.intervalSeconds) || !optionalInteger(value.priority)) return null;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return null;
  if (value.liveRunId !== undefined && !isUuid(value.liveRunId)) return null;
  const triggerType = value.triggerType as InteractionRuleTrigger;
  return {
    name: value.name.trim(), triggerType, matchConfig, templates, action: value.action as InteractionRuleAction,
    cooldownSeconds: (value.cooldownSeconds as number | undefined) ?? (timerTriggers.includes(triggerType) ? 0 : 60),
    intervalSeconds: value.intervalSeconds as number | undefined,
    priority: (value.priority as number | undefined) ?? 100,
    enabled: (value.enabled as boolean | undefined) ?? true,
    liveRunId: value.liveRunId as string | undefined
  };
}

/** Parses an update request: any subset of the create fields; liveRunId null makes the rule tenant-wide. */
export function parseInteractionRulePatch(value: unknown): InteractionRulePatch | null {
  if (!isRecord(value) || Object.keys(value).length === 0 || !Object.keys(value).every((key) => ["name", "triggerType", "matchConfig", "templates", "action", "cooldownSeconds", "intervalSeconds", "priority", "enabled", "liveRunId"].includes(key))) return null;
  const patch: InteractionRulePatch = {};
  if (value.name !== undefined) { if (typeof value.name !== "string") return null; patch.name = value.name.trim(); }
  if (value.triggerType !== undefined) { if (!interactionRuleTriggers.includes(value.triggerType as InteractionRuleTrigger)) return null; patch.triggerType = value.triggerType as InteractionRuleTrigger; }
  if (value.action !== undefined) { if (!["speak", "reply_draft"].includes(value.action as string)) return null; patch.action = value.action as InteractionRuleAction; }
  if (value.matchConfig !== undefined) { const matchConfig = parseMatchConfig(value.matchConfig); if (!matchConfig) return null; patch.matchConfig = matchConfig; }
  if (value.templates !== undefined) { const templates = parseTemplates(value.templates); if (!templates) return null; patch.templates = templates; }
  for (const key of ["cooldownSeconds", "intervalSeconds", "priority"] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key])) return null;
    patch[key] = value[key] as number;
  }
  if (value.enabled !== undefined) { if (typeof value.enabled !== "boolean") return null; patch.enabled = value.enabled; }
  if (value.liveRunId !== undefined) { if (value.liveRunId !== null && !isUuid(value.liveRunId)) return null; patch.liveRunId = value.liveRunId as string | null; }
  return patch;
}

/** The first violated rule of a complete rule, as a message, or null. Mirrors the 084 table constraints. */
export function ruleShapeError(rule: InteractionRuleInput & { defaultKey?: InteractionRuleDefaultKey }): string | null {
  if (!rule.name || rule.name.length > 80) return "规则名称需为 1 到 80 个字符";
  const timer = timerTriggers.includes(rule.triggerType);
  if (rule.action === "reply_draft" && timer) return "定时与冷场规则没有可回复的互动，只能语音播报";
  if (rule.templates.length < 1 || rule.templates.length > 10) return "每条规则需要 1 到 10 条模板";
  for (const template of rule.templates) {
    if (!isValidTemplate(template)) return `模板只能使用槽位 {nickname}、{product_name}、{price}，且长度为 1 到 ${maxTemplateLength} 个字符`;
    if (timer && template.includes("{nickname}")) return "定时与冷场规则没有观众，模板不能使用 {nickname}";
  }
  if (rule.triggerType === "keyword" && !(rule.matchConfig.keywords?.length)) return "关键词规则至少需要一个关键词";
  if (rule.triggerType !== "keyword" && rule.matchConfig.keywords !== undefined) return "只有关键词规则可以设置关键词";
  if (rule.triggerType !== "gift" && rule.matchConfig.minGiftValueCents !== undefined) return "只有礼物规则可以设置礼物最低价值";
  if (!Number.isInteger(rule.cooldownSeconds) || rule.cooldownSeconds < 0 || rule.cooldownSeconds > 86_400) return "冷却时间需为 0 到 86400 秒";
  if (timer && !(Number.isInteger(rule.intervalSeconds) && rule.intervalSeconds! >= 60 && rule.intervalSeconds! <= 86_400)) return "定时与冷场规则的间隔需为 60 到 86400 秒";
  if (!timer && rule.intervalSeconds !== undefined) return "只有定时与冷场规则可以设置间隔";
  const maxPriority = rule.defaultKey === "ai_disclosure" ? 1000 : 999;
  if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > maxPriority) return `优先级需为 0 到 ${maxPriority}`;
  if (rule.defaultKey === "ai_disclosure" && (rule.intervalSeconds! < aiDisclosureIntervalBounds.min || rule.intervalSeconds! > aiDisclosureIntervalBounds.max)) return `AI 身份提示的间隔需为 ${aiDisclosureIntervalBounds.min} 到 ${aiDisclosureIntervalBounds.max} 秒`;
  return null;
}

export function isValidTemplate(template: string) {
  const trimmed = template.trim();
  return trimmed.length > 0 && template.length <= maxTemplateLength && !/[{}]/.test(trimmed.replace(/\{(nickname|product_name|price)\}/g, ""));
}

export function renderTemplate(template: string, slots: Record<string, string>) {
  return template.replace(/\{(nickname|product_name|price)\}/g, (match, name: string) => slots[name] ?? match).replace(/\s+/g, " ").trim();
}

/** Renders every template with the approval sample values and runs the policy engine; returns the failures. */
export function templatePolicyFailures(templates: string[], policyRules: PolicyRule[]): TemplatePolicyFailure[] {
  return templates.flatMap((template, index) => {
    const text = renderTemplate(template, approvalSampleSlots);
    const decision = evaluatePolicy(text, ["product_version"], policyRules);
    return decision.action === "answer" ? [] : [{ index, text, decision: decision.action, reasons: decision.reasons }];
  });
}

// ---- Service functions ----

export async function listInteractionRules(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) return [...ruleStore().rules.values()].filter((rule) => rule.tenantId === context.tenantId).sort(byPriority);
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentRuleRow>(`select ${columns} from interaction_rules order by priority desc, created_at`)).rows.map(persistentRule));
}

export async function getInteractionRule(context: RequestContext, ruleId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) return demoRule(context, ruleId);
  if (!isUuid(ruleId)) throw new Response("Interaction rule not found", { status: 404 });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentRuleRow>(`select ${columns} from interaction_rules where id = $1`, [ruleId])).rows[0];
    if (!row) throw new Response("Interaction rule not found", { status: 404 });
    return persistentRule(row);
  });
}

export async function createInteractionRule(context: RequestContext, input: InteractionRuleInput) {
  requireTenantWideAccess(context);
  const shapeError = ruleShapeError(input);
  if (shapeError) throw new Response(shapeError, { status: 422, statusText: "invalid_interaction_rule" });
  if (!databasePool()) {
    const now = new Date().toISOString();
    const rule: InteractionRule = { id: `interaction_rule_${crypto.randomUUID()}`, tenantId: context.tenantId, ...withoutUndefined(input), approval: "pending", createdAt: now, updatedAt: now };
    ruleStore().rules.set(rule.id, rule);
    await recordAuditEvent(context, ruleAudit("interaction_rule.created", rule));
    return rule;
  }
  return mapDatabaseErrors(() => withTenantTransaction(context.tenantId, async (client) => {
    const rule = await insertRule(client, context, input);
    if (!rule) throw new Error("Interaction rule was not created");
    await recordAuditEventInTransaction(client, context, ruleAudit("interaction_rule.created", rule));
    return rule;
  }));
}

export async function updateInteractionRule(context: RequestContext, ruleId: string, patch: InteractionRulePatch) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existing = demoRule(context, ruleId);
    const { defaultKey, ...next } = mergedRule(existing, patch);
    const reset = contentChanged(existing, next);
    const { liveRunId, intervalSeconds, approvedAt, ...kept } = existing;
    void liveRunId; void intervalSeconds;
    const updated: InteractionRule = { ...kept, ...withoutUndefined(next), ...(defaultKey ? { defaultKey } : {}), ...(reset ? { approval: "pending" as const } : approvedAt ? { approvedAt } : {}), updatedAt: new Date().toISOString() };
    ruleStore().rules.set(ruleId, updated);
    await recordAuditEvent(context, ruleAudit("interaction_rule.updated", updated, { approvalReset: reset }));
    return updated;
  }
  if (!isUuid(ruleId)) throw new Response("Interaction rule not found", { status: 404 });
  return mapDatabaseErrors(() => withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentRuleRow>(`select ${columns} from interaction_rules where id = $1 for update`, [ruleId])).rows[0];
    if (!row) throw new Response("Interaction rule not found", { status: 404 });
    const existing = persistentRule(row);
    const next = mergedRule(existing, patch);
    const reset = contentChanged(existing, next);
    const actor = await syncActor(client, context);
    const updated = (await client.query<PersistentRuleRow>(`update interaction_rules set name = $2, trigger_type = $3, match_config = $4::jsonb, templates = $5::jsonb, action = $6, cooldown_seconds = $7, interval_seconds = $8,
        priority = $9, enabled = $10, live_run_id = $11, updated_by = $12, updated_at = now(),
        approval_status = case when $13::boolean then 'pending'::interaction_rule_approval else approval_status end,
        approved_by = case when $13::boolean then null else approved_by end,
        approved_at = case when $13::boolean then null else approved_at end
      where id = $1 returning ${columns}`,
    [ruleId, next.name, next.triggerType, JSON.stringify(next.matchConfig), JSON.stringify(next.templates), next.action, next.cooldownSeconds, next.intervalSeconds ?? null, next.priority, next.enabled, next.liveRunId ?? null, actor, reset])).rows[0];
    const rule = persistentRule(updated);
    await recordAuditEventInTransaction(client, context, ruleAudit("interaction_rule.updated", rule, { approvalReset: reset }));
    return rule;
  }));
}

/** 停用: rules are never deleted. The AI identity disclosure cannot be disabled. */
export async function disableInteractionRule(context: RequestContext, ruleId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existing = demoRule(context, ruleId);
    assertDisableAllowed(existing);
    const updated = { ...existing, enabled: false, updatedAt: new Date().toISOString() };
    ruleStore().rules.set(ruleId, updated);
    await recordAuditEvent(context, ruleAudit("interaction_rule.disabled", updated));
    return updated;
  }
  if (!isUuid(ruleId)) throw new Response("Interaction rule not found", { status: 404 });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentRuleRow>(`select ${columns} from interaction_rules where id = $1 for update`, [ruleId])).rows[0];
    if (!row) throw new Response("Interaction rule not found", { status: 404 });
    assertDisableAllowed(persistentRule(row));
    const actor = await syncActor(client, context);
    const rule = persistentRule((await client.query<PersistentRuleRow>(`update interaction_rules set enabled = false, updated_by = $2, updated_at = now() where id = $1 returning ${columns}`, [ruleId, actor])).rows[0]);
    await recordAuditEventInTransaction(client, context, ruleAudit("interaction_rule.disabled", rule));
    return rule;
  });
}

/** Approves a pending rule after every template, rendered with sample values, passes the policy engine. */
export async function approveInteractionRule(context: RequestContext, ruleId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existing = demoRule(context, ruleId);
    if (existing.approval !== "pending") throw new Response("Interaction rule is not pending approval", { status: 409 });
    const failures = templatePolicyFailures(existing.templates, []);
    if (failures.length) throw new TemplatePolicyError(failures);
    const approved = { ...existing, approval: "approved" as const, approvedAt: new Date().toISOString() };
    ruleStore().rules.set(ruleId, approved);
    await recordAuditEvent(context, ruleAudit("interaction_rule.approved", approved, { policyChecked: true }));
    return approved;
  }
  if (!isUuid(ruleId)) throw new Response("Interaction rule not found", { status: 404 });
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<PersistentRuleRow>(`select ${columns} from interaction_rules where id = $1 for update`, [ruleId])).rows[0];
    if (!row) throw new Response("Interaction rule not found", { status: 404 });
    if (row.approval_status !== "pending") throw new Response("Interaction rule is not pending approval", { status: 409 });
    // The tenant's newest approved policy profile; each run checks the rendered line again with its bound profile.
    const profile = await latestApprovedPolicyProfile(client);
    const existing = persistentRule(row);
    const failures = templatePolicyFailures(existing.templates, profile?.rules ?? []);
    if (failures.length) throw new TemplatePolicyError(failures);
    const actor = await syncActor(client, context);
    const rule = persistentRule((await client.query<PersistentRuleRow>(`update interaction_rules set approval_status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() where id = $1 and approval_status = 'pending' returning ${columns}`, [ruleId, actor])).rows[0]);
    await recordAuditEventInTransaction(client, context, ruleAudit("interaction_rule.approved", rule, { policyChecked: true, policyProfileId: profile?.id ?? null }));
    return rule;
  });
}

/** 一键创建默认规则: inserts each default rule the tenant does not have yet, pending approval. */
export async function createDefaultInteractionRules(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const existingKeys = new Set([...ruleStore().rules.values()].filter((rule) => rule.tenantId === context.tenantId && rule.defaultKey).map((rule) => rule.defaultKey));
    const created: InteractionRule[] = [];
    for (const preset of defaultInteractionRules.filter((candidate) => !existingKeys.has(candidate.defaultKey))) {
      const now = new Date().toISOString();
      const rule: InteractionRule = { id: `interaction_rule_${crypto.randomUUID()}`, tenantId: context.tenantId, ...withoutUndefined(preset), enabled: true, approval: "pending", createdAt: now, updatedAt: now };
      ruleStore().rules.set(rule.id, rule);
      created.push(rule);
    }
    if (created.length) await recordAuditEvent(context, defaultsAudit(created));
    return { created, existing: defaultInteractionRules.length - created.length };
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const created: InteractionRule[] = [];
    for (const preset of defaultInteractionRules) {
      const rule = await insertRule(client, context, { ...preset, enabled: true }, preset.defaultKey);
      if (rule) created.push(rule);
    }
    if (created.length) await recordAuditEventInTransaction(client, context, defaultsAudit(created));
    return { created, existing: defaultInteractionRules.length - created.length };
  });
}

export async function listInteractionRuleFirings(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) return [] as InteractionRuleFiring[];
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentFiringRow>(`select f.id, f.rule_id, r.name as rule_name, f.live_run_id, f.interaction_id, f.trigger_key, f.template_index, f.rendered_text_sha256, f.outcome, f.outcome_reason, f.outbox_event_id, f.created_at
    from interaction_rule_firings f join interaction_rules r on r.id = f.rule_id
    where f.live_run_id = $1 order by f.created_at desc limit 200`, [runId])).rows.map(persistentFiring));
}

/** Maps a refusal to the API's JSON error; validation and conflict refusals carry their (Chinese) explanation. */
export async function interactionRuleErrorResponse(error: unknown, fallback: string) {
  if (error instanceof TemplatePolicyError) return Response.json({ error: "interaction_rule_template_policy_blocked", failures: error.failures }, { status: 422 });
  if (error instanceof Response) {
    const detail = error.status === 422 || error.status === 409 ? await error.text().catch(() => "") : "";
    return Response.json({ error: error.statusText || fallback, ...(detail ? { detail } : {}) }, { status: error.status });
  }
  throw error;
}

// ---- Helpers ----

// Returns null only for a default rule the tenant already has.
async function insertRule(client: PoolClient, context: RequestContext, input: InteractionRuleInput, defaultKey?: InteractionRuleDefaultKey): Promise<InteractionRule | null> {
  const actor = await syncActor(client, context);
  const result = await client.query<PersistentRuleRow>(`insert into interaction_rules (tenant_id, live_run_id, name, trigger_type, match_config, templates, action, cooldown_seconds, interval_seconds, priority, enabled, default_key, created_by, updated_by)
    values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $13)
    ${defaultKey ? "on conflict (tenant_id, default_key) where default_key is not null do nothing" : ""}
    returning ${columns}`,
  [context.tenantId, input.liveRunId ?? null, input.name, input.triggerType, JSON.stringify(input.matchConfig), JSON.stringify(input.templates), input.action, input.cooldownSeconds, input.intervalSeconds ?? null, input.priority, input.enabled, defaultKey ?? null, actor]);
  return result.rows[0] ? persistentRule(result.rows[0]) : null;
}

function mergedRule(existing: InteractionRule, patch: InteractionRulePatch): InteractionRuleInput & { defaultKey?: InteractionRuleDefaultKey } {
  if (existing.defaultKey === "ai_disclosure") {
    const allowed = Object.entries(patch).every(([key, value]) => key === "intervalSeconds" || (key === "enabled" && value === true));
    if (!allowed) throw new Response("Only the interval of the AI identity disclosure rule can change", { status: 409, statusText: "ai_disclosure_rule_protected" });
  }
  const triggerType = patch.triggerType ?? existing.triggerType;
  const timer = timerTriggers.includes(triggerType);
  const next = {
    name: patch.name ?? existing.name,
    triggerType,
    matchConfig: patch.matchConfig ?? existing.matchConfig,
    templates: patch.templates ?? existing.templates,
    action: patch.action ?? existing.action,
    cooldownSeconds: patch.cooldownSeconds ?? existing.cooldownSeconds,
    intervalSeconds: timer ? patch.intervalSeconds ?? existing.intervalSeconds : undefined,
    priority: patch.priority ?? existing.priority,
    enabled: patch.enabled ?? existing.enabled,
    liveRunId: patch.liveRunId === null ? undefined : patch.liveRunId ?? existing.liveRunId,
    defaultKey: existing.defaultKey
  };
  const shapeError = ruleShapeError(next);
  if (shapeError) throw new Response(shapeError, { status: 422, statusText: "invalid_interaction_rule" });
  return next;
}

function contentChanged(existing: InteractionRule, next: InteractionRuleInput) {
  return existing.triggerType !== next.triggerType || existing.action !== next.action || (existing.liveRunId ?? null) !== (next.liveRunId ?? null)
    || JSON.stringify(existing.templates) !== JSON.stringify(next.templates) || JSON.stringify(normalizedMatch(existing.matchConfig)) !== JSON.stringify(normalizedMatch(next.matchConfig));
}

function assertDisableAllowed(rule: InteractionRule) {
  if (rule.defaultKey === "ai_disclosure") throw new Response("The AI identity disclosure rule cannot be disabled or deleted", { status: 409, statusText: "ai_disclosure_rule_protected" });
}

function demoRule(context: RequestContext, ruleId: string) {
  const rule = ruleStore().rules.get(ruleId);
  if (!rule || rule.tenantId !== context.tenantId) throw new Response("Interaction rule not found", { status: 404 });
  return rule;
}

function ruleAudit(type: string, rule: InteractionRule, extra: Record<string, string | number | boolean | null> = {}): AuditEventInput {
  return { type, resource: "interaction_rule", resourceId: rule.id, detail: { name: rule.name, triggerType: rule.triggerType, action: rule.action, templateCount: rule.templates.length, enabled: rule.enabled, approval: rule.approval, liveRunId: rule.liveRunId ?? null, defaultKey: rule.defaultKey ?? null, ...extra } };
}

function defaultsAudit(created: InteractionRule[]): AuditEventInput {
  return { type: "interaction_rule.defaults_created", resource: "interaction_rule", resourceId: created[0].id, detail: { count: created.length, defaultKeys: created.map((rule) => rule.defaultKey).join(",") } };
}

async function mapDatabaseErrors<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "23503") throw new Response("Live run not found", { status: 404, statusText: "live_run_not_found" });
    if (code === "23514" || code === "P0001") throw new Response("Interaction rule violates a database rule", { status: 409, statusText: "interaction_rule_rejected" });
    throw error;
  }
}

function parseMatchConfig(value: unknown): InteractionRuleMatchConfig | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "keywords" || key === "minGiftValueCents")) return null;
  const config: InteractionRuleMatchConfig = {};
  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords) || value.keywords.length < 1 || value.keywords.length > 20 || !value.keywords.every((keyword) => typeof keyword === "string" && keyword.trim().length > 0 && keyword.trim().length <= 30)) return null;
    config.keywords = [...new Set((value.keywords as string[]).map((keyword) => keyword.trim()))];
  }
  if (value.minGiftValueCents !== undefined) {
    if (!Number.isSafeInteger(value.minGiftValueCents) || (value.minGiftValueCents as number) < 0 || (value.minGiftValueCents as number) > 1_000_000_000_000) return null;
    config.minGiftValueCents = value.minGiftValueCents as number;
  }
  return config;
}

function parseTemplates(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || !value.every((template) => typeof template === "string")) return null;
  return (value as string[]).map((template) => template.trim());
}

function normalizedMatch(config: InteractionRuleMatchConfig) { return { keywords: config.keywords ?? null, minGiftValueCents: config.minGiftValueCents ?? null }; }
function optionalInteger(value: unknown) { return value === undefined || Number.isInteger(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function byPriority(left: InteractionRule, right: InteractionRule) { return right.priority - left.priority || left.createdAt.localeCompare(right.createdAt); }
function withoutUndefined<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T; }
function at(value: Date | string | null) { return value ? new Date(value).toISOString() : undefined; }
function jsonValue(value: unknown) { if (typeof value === "string") { try { return JSON.parse(value) as unknown; } catch { return undefined; } } return value; }
async function syncActor(client: PoolClient, context: RequestContext) { return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id; }

function persistentRule(row: PersistentRuleRow): InteractionRule {
  const templates = jsonValue(row.templates);
  const matchConfig = parseMatchConfig(jsonValue(row.match_config) ?? {}) ?? {};
  return {
    id: row.id, tenantId: row.tenant_id, ...(row.live_run_id ? { liveRunId: row.live_run_id } : {}), name: row.name, triggerType: row.trigger_type, matchConfig,
    templates: Array.isArray(templates) ? templates.filter((template): template is string => typeof template === "string") : [], action: row.action,
    cooldownSeconds: row.cooldown_seconds, ...(row.interval_seconds !== null ? { intervalSeconds: row.interval_seconds } : {}), priority: row.priority, enabled: row.enabled,
    ...(row.default_key ? { defaultKey: row.default_key } : {}), approval: row.approval_status, ...(row.approved_at ? { approvedAt: at(row.approved_at) } : {}),
    createdAt: at(row.created_at)!, updatedAt: at(row.updated_at)!
  };
}

function persistentFiring(row: PersistentFiringRow): InteractionRuleFiring {
  return {
    id: row.id, ruleId: row.rule_id, ruleName: row.rule_name, runId: row.live_run_id, ...(row.interaction_id ? { interactionId: row.interaction_id } : {}), triggerKey: row.trigger_key,
    ...(row.template_index !== null ? { templateIndex: row.template_index } : {}), ...(row.rendered_text_sha256 ? { renderedTextSha256: row.rendered_text_sha256 } : {}),
    outcome: row.outcome, ...(row.outcome_reason ? { outcomeReason: row.outcome_reason } : {}), ...(row.outbox_event_id ? { outboxEventId: row.outbox_event_id } : {}), createdAt: at(row.created_at)!
  };
}
