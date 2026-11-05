// Live interaction rules (migration 084): interaction_rules_governed_mutation on INSERT, UPDATE and DELETE, and
// interaction_rule_firings_append_only on UPDATE and DELETE. Message texts are the raise exception texts of
// enforce_interaction_rule_mutation() and reject_interaction_rule_firing_mutation() in 084.
import { randomUUID } from "node:crypto";
const RULES = "interaction_rules";
const RULE_TRIGGER = "interaction_rules_governed_mutation";
const FIRINGS = "interaction_rule_firings";
const FIRING_TRIGGER = "interaction_rule_firings_append_only";
const RULE_COLUMNS = "id, tenant_id, name, trigger_type::text as trigger_type, templates, action::text as action, interval_seconds, enabled, default_key, approval_status::text as approval_status, approved_by, approved_at is not null as has_approved_at";
const readRule = (_ctx, a) => ({ sql: `select ${RULE_COLUMNS} from interaction_rules where id = $1`, params: [a.ruleId] });
const readFiring = (_ctx, a) => ({ sql: "select id, rule_id, live_run_id, trigger_key, outcome, outcome_reason from interaction_rule_firings where id = $1", params: [a.firingId] });
async function tenantWithMember({ seed }) {
  const tenantId = await seed.tenant();
  const memberId = await seed.member({ tenantId, role: "admin" });
  return { tenantId, memberId };
}
/** A pending welcome rule, or the tenant's spoken AI identity disclosure (timed, every 600 s). */
async function seedRule({ client }, { tenantId, memberId }, { approve = false, disclosure = false } = {}) {
  const ruleId = randomUUID();
  await client.query(
    disclosure
      ? "insert into interaction_rules (id, tenant_id, name, trigger_type, templates, action, interval_seconds, default_key, created_by) values ($1, $2, 'AI 身份提示', 'timed', '[\"本直播由AI数字人主播进行\"]'::jsonb, 'speak', 600, 'ai_disclosure', $3)"
      : "insert into interaction_rules (id, tenant_id, name, trigger_type, templates, action, created_by) values ($1, $2, '欢迎', 'viewer_enter', '[\"欢迎{nickname}来到直播间\"]'::jsonb, 'speak', $3)",
    [ruleId, tenantId, memberId]
  );
  if (approve) await client.query("update interaction_rules set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [ruleId, memberId]);
  return ruleId;
}
async function firingFixture(ctx) {
  const own = await tenantWithMember(ctx);
  const ruleId = await seedRule(ctx, own, { approve: true });
  const { revisionId } = await ctx.seed.revision({ tenantId: own.tenantId, approver: own.memberId });
  const liveRunId = await ctx.seed.liveRun({ tenantId: own.tenantId, revisionId });
  const firingId = randomUUID();
  await ctx.client.query("insert into interaction_rule_firings (id, tenant_id, rule_id, live_run_id, trigger_key, outcome, outcome_reason) values ($1, $2, $3, $4, 'slot:1', 'suppressed', 'integration fixture')", [firingId, own.tenantId, ruleId, liveRunId]);
  return { ...own, ruleId, liveRunId, firingId };
}
export default [
  {
    id: "interaction_rules.governed_mutation.insert.pending.accept",
    table: RULES, trigger: RULE_TRIGGER, op: "INSERT", expect: "accept",
    async arrange(ctx) { return { ...(await tenantWithMember(ctx)), ruleId: randomUUID() }; },
    act: (_ctx, a) => ({ sql: "insert into interaction_rules (id, tenant_id, name, trigger_type, templates, action, created_by) values ($1, $2, '关注感谢', 'follow', '[\"感谢{nickname}的关注\"]'::jsonb, 'speak', $3)", params: [a.ruleId, a.tenantId, a.memberId] }),
    readBack: readRule,
    expectedAfter: (a) => [{ id: a.ruleId, tenant_id: a.tenantId, trigger_type: "follow", approval_status: "pending", approved_by: null, has_approved_at: false, enabled: true }]
  },
  {
    id: "interaction_rules.governed_mutation.insert.approved.reject",
    table: RULES, trigger: RULE_TRIGGER, op: "INSERT", expect: "reject",
    message: "interaction rules must be created pending approval",
    async arrange(ctx) { return { ...(await tenantWithMember(ctx)), ruleId: randomUUID() }; },
    act: (_ctx, a) => ({ sql: "insert into interaction_rules (id, tenant_id, name, trigger_type, templates, action, approval_status, approved_by, approved_at, created_by) values ($1, $2, '关注感谢', 'follow', '[\"感谢{nickname}的关注\"]'::jsonb, 'speak', 'approved', $3, now(), $3)", params: [a.ruleId, a.tenantId, a.memberId] }),
    readBack: readRule
  },
  {
    id: "interaction_rules.governed_mutation.update.approve.accept",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["approval_status", "approved_by", "approved_at"], expect: "accept",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", params: [a.ruleId, a.memberId] }),
    readBack: readRule,
    expectedAfter: (a) => [{ id: a.ruleId, approval_status: "approved", approved_by: a.memberId, has_approved_at: true }]
  },
  {
    id: "interaction_rules.governed_mutation.update.disable.accept",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["enabled"], expect: "accept",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own, { approve: true }) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set enabled = false where id = $1", params: [a.ruleId] }),
    readBack: readRule,
    expectedAfter: (a) => [{ id: a.ruleId, enabled: false, approval_status: "approved", approved_by: a.memberId }]
  },
  {
    id: "interaction_rules.governed_mutation.update.approved_templates.reject",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["templates"], expect: "reject",
    message: "a changed interaction rule must return to pending approval",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own, { approve: true }) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set templates = '[\"欢迎光临\"]'::jsonb where id = $1", params: [a.ruleId] }),
    readBack: readRule
  },
  {
    id: "interaction_rules.governed_mutation.update.tenant_id.reject",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["tenant_id"], expect: "reject",
    message: "interaction rule identity is immutable",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, otherTenantId: await ctx.seed.tenant(), ruleId: await seedRule(ctx, own) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set tenant_id = $2 where id = $1", params: [a.ruleId, a.otherTenantId] }),
    readBack: readRule
  },
  {
    id: "interaction_rules.governed_mutation.update.disable_ai_disclosure.reject",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["enabled"], expect: "reject",
    message: "the AI identity disclosure rule cannot be disabled",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own, { approve: true, disclosure: true }) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set enabled = false where id = $1", params: [a.ruleId] }),
    readBack: readRule
  },
  {
    id: "interaction_rules.governed_mutation.update.ai_disclosure_interval.accept",
    table: RULES, trigger: RULE_TRIGGER, op: "UPDATE", updatedColumns: ["interval_seconds"], expect: "accept",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own, { approve: true, disclosure: true }) };
    },
    act: (_ctx, a) => ({ sql: "update interaction_rules set interval_seconds = 900 where id = $1", params: [a.ruleId] }),
    readBack: readRule,
    expectedAfter: (a) => [{ id: a.ruleId, default_key: "ai_disclosure", interval_seconds: 900, enabled: true, approval_status: "approved" }]
  },
  {
    id: "interaction_rules.governed_mutation.delete.reject",
    table: RULES, trigger: RULE_TRIGGER, op: "DELETE", expect: "reject",
    message: "interaction rules are retained for audit; disable the rule instead",
    async arrange(ctx) {
      const own = await tenantWithMember(ctx);
      return { ...own, ruleId: await seedRule(ctx, own) };
    },
    act: (_ctx, a) => ({ sql: "delete from interaction_rules where id = $1", params: [a.ruleId] }),
    readBack: readRule
  },
  {
    id: "interaction_rule_firings.append_only.update.reject",
    table: FIRINGS, trigger: FIRING_TRIGGER, op: "UPDATE", updatedColumns: ["outcome_reason"], expect: "reject",
    message: "interaction rule firings are append-only",
    arrange: firingFixture,
    act: (_ctx, a) => ({ sql: "update interaction_rule_firings set outcome_reason = 'rewritten' where id = $1", params: [a.firingId] }),
    readBack: readFiring
  },
  {
    id: "interaction_rule_firings.append_only.delete.reject",
    table: FIRINGS, trigger: FIRING_TRIGGER, op: "DELETE", expect: "reject",
    message: "interaction rule firings are append-only",
    arrange: firingFixture,
    act: (_ctx, a) => ({ sql: "delete from interaction_rule_firings where id = $1", params: [a.firingId] }),
    readBack: readFiring
  }
];
