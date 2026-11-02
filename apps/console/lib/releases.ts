import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { quarantineLiveRunsForRevocationInTransaction, type GovernanceQuarantineImpact } from "@/lib/control-plane/governance-quarantine";

export type ReleaseComponent = "runtime" | "avatar" | "lip_sync" | "voice";
export type ReleaseApproval = "pending" | "approved" | "revoked";
export const requiredProductionReleaseComponents: ReleaseComponent[] = ["runtime", "lip_sync", "voice"];
export type ModelRelease = { id: string; tenantId: string; name: string; version: string; component: ReleaseComponent; sourceCommit: string; imageDigest: string; artifactHash: string; driverVersion: string; license: string; rightsScope: string; evidenceRef: string; validationSummary: string; notes?: string; approval: ReleaseApproval; approvedAt?: string; revokedAt?: string; revocationReason?: string };
export type CreateModelReleaseInput = Omit<ModelRelease, "id" | "tenantId" | "approval" | "approvedAt" | "revokedAt" | "revocationReason">;
export type ModelReleaseRevocation = { release: ModelRelease; impact: GovernanceQuarantineImpact };
type ReleaseStore = { releases: Map<string, ModelRelease> };
type PersistentReleaseRow = { id: string; tenant_id: string; name: string; version: string; component: ReleaseComponent; source_commit: string; image_digest: string; artifact_hash: string; driver_version: string; license: string; rights_scope: string; evidence_ref: string; validation_summary: string; notes: string | null; approval_status: ReleaseApproval; approved_at: Date | string | null; revoked_at: Date | string | null; revocation_reason: string | null };

declare global { var shuzhirenReleaseStore: ReleaseStore | undefined; }

function releaseStore(): ReleaseStore {
  globalThis.shuzhirenReleaseStore ??= { releases: new Map([
    ["release_runtime_demo", { id: "release_runtime_demo", tenantId: "tenant_demo", name: "LiveTalking runtime", version: "2026.11.01", component: "runtime", sourceCommit: "4b52d8e", imageDigest: "sha256:runtime-demo", artifactHash: "sha256:runtime-lock-demo", driverVersion: "NVIDIA 570.124", license: "Apache-2.0", rightsScope: "开发态 fixture，不得用于真实开播", evidenceRef: "demo://runtime-fixture", validationSummary: "开发态演示数据，不构成 GPU 或推流验收证据", notes: "由 runtime/open-source.lock.json 锁定", approval: "approved", approvedAt: "2026-11-01T09:10:00.000Z" }],
    ["release_lipsync_demo", { id: "release_lipsync_demo", tenantId: "tenant_demo", name: "MuseTalk", version: "1.5", component: "lip_sync", sourceCommit: "8c2d7a1", imageDigest: "sha256:lipsync-demo", artifactHash: "sha256:lipsync-weight-demo", driverVersion: "NVIDIA 570.124", license: "MIT", rightsScope: "开发态 fixture，不得用于真实开播", evidenceRef: "demo://lipsync-fixture", validationSummary: "开发态演示数据，不构成 GPU 或口型验收证据", approval: "approved", approvedAt: "2026-11-01T09:11:00.000Z" }],
    ["release_voice_demo", { id: "release_voice_demo", tenantId: "tenant_demo", name: "CosyVoice", version: "2.0", component: "voice", sourceCommit: "c1e847a", imageDigest: "sha256:voice-demo", artifactHash: "sha256:voice-weight-demo", driverVersion: "NVIDIA 570.124", license: "Apache-2.0", rightsScope: "开发态 fixture，不得用于真实开播", evidenceRef: "demo://voice-fixture", validationSummary: "开发态演示数据，不构成 GPU 或语音验收证据", approval: "approved", approvedAt: "2026-11-01T09:12:00.000Z" }]
  ]) };
  return globalThis.shuzhirenReleaseStore;
}

const columns = "id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, notes, approval_status, approved_at, revoked_at, revocation_reason";

export async function listModelReleases(context: RequestContext) {
  if (!databasePool()) return [...releaseStore().releases.values()].filter((release) => release.tenantId === context.tenantId);
  return withTenantTransaction(context.tenantId, async (client) => (await client.query<PersistentReleaseRow>(`select ${columns} from model_releases order by created_at desc`)).rows.map(persistentRelease));
}

export async function createModelRelease(context: RequestContext, input: CreateModelReleaseInput) {
  if (!databasePool()) {
    if ([...releaseStore().releases.values()].some((release) => release.tenantId === context.tenantId && release.component === input.component && release.name === input.name && release.version === input.version)) throw new Response("Model release already exists", { status: 409 });
    const release: ModelRelease = { id: `release_${crypto.randomUUID()}`, tenantId: context.tenantId, approval: "pending", ...input };
    releaseStore().releases.set(release.id, release);
    return release;
  }
  try {
    return await withTenantTransaction(context.tenantId, async (client) => persistentRelease((await client.query<PersistentReleaseRow>(`insert into model_releases (tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning ${columns}`, [context.tenantId, input.name, input.version, input.component, input.sourceCommit, input.imageDigest, input.artifactHash, input.driverVersion, input.license, input.rightsScope, input.evidenceRef, input.validationSummary, input.notes ?? null])).rows[0]));
  } catch (error) {
    if (databaseErrorCode(error) === "23505") throw new Response("Model release already exists", { status: 409 });
    throw error;
  }
}

export async function approveModelRelease(context: RequestContext, releaseId: string) {
  if (!databasePool()) {
    const release = releaseStore().releases.get(releaseId);
    if (!release || release.tenantId !== context.tenantId || release.approval !== "pending") throw new Response("Model release not found or cannot be approved", { status: 409 });
    if (!release.evidenceRef.trim() || !release.validationSummary.trim()) throw new Response("Release evidence is required before approval", { status: 409 });
    release.approval = "approved"; release.approvedAt = new Date().toISOString(); return release;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentReleaseRow>(`update model_releases set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 and approval_status = 'pending' and btrim(evidence_ref) <> '' and btrim(validation_summary) <> '' returning ${columns}`, [releaseId, actor.rows[0].id]);
    if (!result.rows[0]) throw new Response("Model release not found or cannot be approved", { status: 409 });
    return persistentRelease(result.rows[0]);
  });
}

export async function revokeModelRelease(context: RequestContext, releaseId: string, reason: string) {
  if (!databasePool()) {
    const release = releaseStore().releases.get(releaseId);
    if (!release || release.tenantId !== context.tenantId || release.approval !== "approved") throw new Response("Model release not found or cannot be revoked", { status: 409 });
    release.approval = "revoked"; release.revokedAt = new Date().toISOString(); release.revocationReason = reason;
    return { release, impact: { liveRunIds: [], humanHandoffQueuedRunIds: [] } } satisfies ModelReleaseRevocation;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentReleaseRow>(`update model_releases set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = $3 where id = $1 and approval_status = 'approved' returning ${columns}`, [releaseId, actor.rows[0].id, reason]);
    if (!result.rows[0]) throw new Response("Model release not found or cannot be revoked", { status: 409 });
    const impact = await quarantineLiveRunsForRevocationInTransaction(client, context, "model_release", releaseId, reason);
    return { release: persistentRelease(result.rows[0]), impact } satisfies ModelReleaseRevocation;
  });
}

export async function hasApprovedProductionReleases(context: RequestContext, revisionId?: string) {
  return (await activeModelReleaseStatus(context, revisionId)).active;
}

export async function activeModelReleaseStatus(context: RequestContext, revisionId?: string) {
  if (!databasePool()) {
    const approved = new Set([...releaseStore().releases.values()].filter((release) => release.tenantId === context.tenantId && release.approval === "approved").map((release) => release.component));
    const missing = requiredProductionReleaseComponents.filter((component) => !approved.has(component));
    return missing.length === 0 ? { active: true, detail: "开发态运行时、口型驱动与语音发布包均已批准" } : { active: false, detail: `缺少已批准发布包：${missing.join("、")}` };
  }
  return withTenantTransaction(context.tenantId, async (client) => activeModelReleaseStatusInTransaction(client, revisionId));
}

export async function activeModelReleaseStatusInTransaction(client: PoolClient, revisionId?: string) {
  const result = await client.query<{ component: ReleaseComponent; name: string; version: string; approval_status: ReleaseApproval; evidence_ref: string; validation_summary: string }>(revisionId
    ? "select binding.component, release.name, release.version, release.approval_status, release.evidence_ref, release.validation_summary from show_revision_model_releases binding join model_releases release on release.id = binding.model_release_id where binding.show_revision_id = $1 and binding.component = any($2::model_release_component[])"
    : "select component, name, version, approval_status, evidence_ref, validation_summary from model_releases where component = any($1::model_release_component[]) order by approved_at desc nulls last", revisionId ? [revisionId, requiredProductionReleaseComponents] : [requiredProductionReleaseComponents]);
  const failures = requiredProductionReleaseComponents.flatMap((component) => {
    const matches = result.rows.filter((release) => release.component === component);
    if (matches.length !== 1) return [`${component} 缺少唯一冻结发布包`];
    const release = matches[0];
    return release.approval_status === "approved" && release.evidence_ref.trim() && release.validation_summary.trim() ? [] : [`${component} ${release.name} v${release.version} 已撤销、未批准或缺少验收证据`];
  });
  return failures.length === 0 ? { active: true, detail: revisionId ? "已冻结运行时、口型驱动与语音发布包均有效" : "运行时、口型驱动与语音发布包均已批准" } : { active: false, detail: failures.join("；") };
}

function persistentRelease(row: PersistentReleaseRow): ModelRelease { return { id: row.id, tenantId: row.tenant_id, name: row.name, version: row.version, component: row.component, sourceCommit: row.source_commit, imageDigest: row.image_digest, artifactHash: row.artifact_hash, driverVersion: row.driver_version, license: row.license, rightsScope: row.rights_scope, evidenceRef: row.evidence_ref, validationSummary: row.validation_summary, notes: row.notes ?? undefined, approval: row.approval_status, approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined, revocationReason: row.revocation_reason ?? undefined }; }
function databaseErrorCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
