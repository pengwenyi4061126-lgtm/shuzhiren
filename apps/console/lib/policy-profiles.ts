import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import type { PolicyRule } from "@/lib/policy-engine";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type PolicyProfileApproval = "pending" | "approved" | "revoked";
export type PolicyProfile = { id: string; tenantId: string; name: string; version: string; rules: PolicyRule[]; evidenceRef: string; validationSummary: string; approval: PolicyProfileApproval; approvedAt?: string; revokedAt?: string; revocationReason?: string };
export type CreatePolicyProfileInput = Pick<PolicyProfile, "name" | "version" | "rules" | "evidenceRef" | "validationSummary">;
type PersistentProfileRow = { id: string; tenant_id: string; name: string; version: string; rules: unknown; evidence_ref: string; validation_summary: string; approval_status: PolicyProfileApproval; approved_at: Date | string | null; revoked_at: Date | string | null; revocation_reason: string | null };
type BoundPolicyProfileRow = Pick<PersistentProfileRow, "name" | "version" | "rules" | "approval_status">;
type ProfileStore = { profiles: Map<string, PolicyProfile> };

declare global { var shuzhirenPolicyProfileStore: ProfileStore | undefined; }

function profileStore() {
  globalThis.shuzhirenPolicyProfileStore ??= { profiles: new Map([
    ["policy_profile_demo", { id: "policy_profile_demo", tenantId: "tenant_demo", name: "直播基础安全策略", version: "2026.11", rules: [], evidenceRef: "demo://policy-baseline", validationSummary: "开发态基线策略 fixture，不构成真实合规验收。", approval: "approved", approvedAt: "2026-11-01T08:00:00.000Z" }]
  ]) };
  return globalThis.shuzhirenPolicyProfileStore;
}

const columns = "id, tenant_id, name, version, rules, evidence_ref, validation_summary, approval_status, approved_at, revoked_at, revocation_reason";

export async function listPolicyProfiles(context: RequestContext) {
  if (!databasePool()) return [...profileStore().profiles.values()].filter((profile) => profile.tenantId === context.tenantId);
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentProfileRow>(`select ${columns} from policy_profiles order by created_at desc`)).rows.map(persistentProfile));
}

export async function createPolicyProfile(context: RequestContext, input: CreatePolicyProfileInput) {
  if (!databasePool()) {
    if ([...profileStore().profiles.values()].some((profile) => profile.tenantId === context.tenantId && profile.name === input.name && profile.version === input.version)) throw new Response("Policy profile already exists", { status: 409 });
    const profile: PolicyProfile = { id: `policy_profile_${crypto.randomUUID()}`, tenantId: context.tenantId, approval: "pending", ...input };
    profileStore().profiles.set(profile.id, profile); return profile;
  }
  try {
    return await withTenantTransaction(context.tenantId, async (client) => persistentProfile((await client.query<PersistentProfileRow>(`insert into policy_profiles (tenant_id, name, version, rules, evidence_ref, validation_summary) values ($1, $2, $3, $4::jsonb, $5, $6) returning ${columns}`, [context.tenantId, input.name, input.version, JSON.stringify(input.rules), input.evidenceRef, input.validationSummary])).rows[0]));
  } catch (error) {
    if (databaseErrorCode(error) === "23505") throw new Response("Policy profile already exists", { status: 409 });
    throw error;
  }
}

export async function approvePolicyProfile(context: RequestContext, profileId: string) {
  if (!databasePool()) {
    const profile = profileStore().profiles.get(profileId);
    if (!profile || profile.tenantId !== context.tenantId) throw new Response("Policy profile not found", { status: 404 });
    profile.approval = "approved"; profile.approvedAt = new Date().toISOString(); return profile;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const result = await client.query<PersistentProfileRow>(`update policy_profiles set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 and approval_status = 'pending' and btrim(evidence_ref) <> '' and btrim(validation_summary) <> '' returning ${columns}`, [profileId, actor]);
    if (!result.rows[0]) throw new Response("Policy profile not found or cannot be approved", { status: 409 });
    return persistentProfile(result.rows[0]);
  });
}

export async function revokePolicyProfile(context: RequestContext, profileId: string, reason: string) {
  if (!databasePool()) {
    const profile = profileStore().profiles.get(profileId);
    if (!profile || profile.tenantId !== context.tenantId || profile.approval !== "approved") throw new Response("Policy profile not found or cannot be revoked", { status: 409 });
    profile.approval = "revoked"; profile.approvedAt = undefined; profile.revokedAt = new Date().toISOString(); profile.revocationReason = reason;
    return profile;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const result = await client.query<PersistentProfileRow>(`update policy_profiles set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = $3 where id = $1 and approval_status = 'approved' returning ${columns}`, [profileId, actor, reason]);
    if (!result.rows[0]) throw new Response("Policy profile not found or cannot be revoked", { status: 409 });
    return persistentProfile(result.rows[0]);
  });
}

export async function latestApprovedPolicyProfile(client: PoolClient) {
  const result = await client.query<PersistentProfileRow>(`select ${columns} from policy_profiles where approval_status = 'approved' and btrim(evidence_ref) <> '' and btrim(validation_summary) <> '' order by approved_at desc limit 1`);
  return result.rows[0] ? persistentProfile(result.rows[0]) : null;
}

export async function policyRulesForRun(context: RequestContext, runId: string) {
  if (!databasePool()) return [];
  return withTenantTransaction(context.tenantId, async (client) => policyRulesForRunInTransaction(client, runId));
}

export async function policyRulesForRunInTransaction(client: PoolClient, runId: string) {
  const profile = await boundPolicyProfile(client, runId);
  if (!profile) throw new Response("Live run has no policy profile binding", { status: 409 });
  if (profile.approval_status !== "approved") throw new Response("Live run policy profile is not active", { status: 409 });
  return parseRules(profile.rules);
}

export async function activePolicyProfileStatusForRun(context: RequestContext, runId: string) {
  if (!databasePool()) return { active: true, detail: "开发态策略包 fixture 已绑定" };
  return withTenantTransaction(context.tenantId, async (client) => {
    const profile = await boundPolicyProfile(client, runId);
    if (!profile) return { active: false, detail: "场次修订未绑定策略包" };
    return profile.approval_status === "approved" ? { active: true, detail: `已冻结策略包 ${profile.name} v${profile.version}` } : { active: false, detail: `已冻结策略包 ${profile.name} v${profile.version} 已撤销或未批准` };
  });
}

async function boundPolicyProfile(client: PoolClient, runId: string) {
  const result = await client.query<BoundPolicyProfileRow>(`select p.name, p.version, p.rules, p.approval_status from live_runs r join show_revision_policy_profiles binding on binding.show_revision_id = r.show_revision_id join policy_profiles p on p.id = binding.policy_profile_id where r.id = $1`, [runId]);
  return result.rows[0] ?? null;
}

function persistentProfile(row: PersistentProfileRow): PolicyProfile { return { id: row.id, tenantId: row.tenant_id, name: row.name, version: row.version, rules: parseRules(row.rules), evidenceRef: row.evidence_ref, validationSummary: row.validation_summary, approval: row.approval_status, approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined, revocationReason: row.revocation_reason ?? undefined }; }
function parseRules(value: unknown): PolicyRule[] { return Array.isArray(value) ? value.filter(isPolicyRule) : typeof value === "string" ? parseRules(JSON.parse(value)) : []; }
export function isPolicyRule(value: unknown): value is PolicyRule { if (!value || typeof value !== "object") return false; const rule = value as Record<string, unknown>; return typeof rule.id === "string" && rule.id.length > 0 && rule.id.length <= 100 && Array.isArray(rule.terms) && rule.terms.length > 0 && rule.terms.length <= 20 && rule.terms.every((term) => typeof term === "string" && term.trim().length > 0 && term.length <= 100) && typeof rule.reason === "string" && rule.reason.trim().length > 0 && rule.reason.length <= 300 && ["answer", "handoff", "refuse"].includes(rule.action as string) && ["low", "medium", "high"].includes(rule.riskLevel as string) && Array.isArray(rule.requiredEvidence) && rule.requiredEvidence.every((item) => typeof item === "string" && item.length <= 100); }
async function syncActor(client: PoolClient, context: RequestContext) { return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id; }
function databaseErrorCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
