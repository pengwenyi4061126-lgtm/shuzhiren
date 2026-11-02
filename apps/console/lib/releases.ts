import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type ReleaseComponent = "runtime" | "avatar" | "lip_sync" | "voice";
export type ReleaseApproval = "pending" | "approved" | "revoked";
export type ModelRelease = { id: string; tenantId: string; name: string; version: string; component: ReleaseComponent; sourceCommit: string; imageDigest: string; artifactHash: string; driverVersion: string; license: string; rightsScope: string; notes?: string; approval: ReleaseApproval; approvedAt?: string };
export type CreateModelReleaseInput = Omit<ModelRelease, "id" | "tenantId" | "approval" | "approvedAt">;
type ReleaseStore = { releases: Map<string, ModelRelease> };
type PersistentReleaseRow = { id: string; tenant_id: string; name: string; version: string; component: ReleaseComponent; source_commit: string; image_digest: string; artifact_hash: string; driver_version: string; license: string; rights_scope: string; notes: string | null; approval_status: ReleaseApproval; approved_at: Date | string | null };

declare global { var shuzhirenReleaseStore: ReleaseStore | undefined; }

function releaseStore(): ReleaseStore {
  globalThis.shuzhirenReleaseStore ??= { releases: new Map([
    ["release_runtime_demo", { id: "release_runtime_demo", tenantId: "tenant_demo", name: "LiveTalking runtime", version: "2026.11.01", component: "runtime", sourceCommit: "4b52d8e", imageDigest: "sha256:runtime-demo", artifactHash: "sha256:runtime-lock-demo", driverVersion: "NVIDIA 570.124", license: "Apache-2.0", rightsScope: "单 4090 店播试运营", notes: "由 runtime/open-source.lock.json 锁定", approval: "approved", approvedAt: "2026-11-01T09:10:00.000Z" }],
    ["release_lipsync_demo", { id: "release_lipsync_demo", tenantId: "tenant_demo", name: "MuseTalk", version: "1.5", component: "lip_sync", sourceCommit: "8c2d7a1", imageDigest: "sha256:lipsync-demo", artifactHash: "sha256:lipsync-weight-demo", driverVersion: "NVIDIA 570.124", license: "MIT", rightsScope: "单 4090 中文店播", approval: "approved", approvedAt: "2026-11-01T09:11:00.000Z" }],
    ["release_voice_demo", { id: "release_voice_demo", tenantId: "tenant_demo", name: "CosyVoice", version: "2.0", component: "voice", sourceCommit: "c1e847a", imageDigest: "sha256:voice-demo", artifactHash: "sha256:voice-weight-demo", driverVersion: "NVIDIA 570.124", license: "Apache-2.0", rightsScope: "已授权中文商品讲解", approval: "approved", approvedAt: "2026-11-01T09:12:00.000Z" }]
  ]) };
  return globalThis.shuzhirenReleaseStore;
}

const columns = "id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, notes, approval_status, approved_at";

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
    return await withTenantTransaction(context.tenantId, async (client) => persistentRelease((await client.query<PersistentReleaseRow>(`insert into model_releases (tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${columns}`, [context.tenantId, input.name, input.version, input.component, input.sourceCommit, input.imageDigest, input.artifactHash, input.driverVersion, input.license, input.rightsScope, input.notes ?? null])).rows[0]));
  } catch (error) {
    if (databaseErrorCode(error) === "23505") throw new Response("Model release already exists", { status: 409 });
    throw error;
  }
}

export async function approveModelRelease(context: RequestContext, releaseId: string) {
  if (!databasePool()) {
    const release = releaseStore().releases.get(releaseId);
    if (!release || release.tenantId !== context.tenantId) throw new Response("Model release not found", { status: 404 });
    release.approval = "approved"; release.approvedAt = new Date().toISOString(); return release;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentReleaseRow>(`update model_releases set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 returning ${columns}`, [releaseId, actor.rows[0].id]);
    if (!result.rows[0]) throw new Response("Model release not found", { status: 404 });
    return persistentRelease(result.rows[0]);
  });
}

export async function hasApprovedProductionReleases(context: RequestContext) {
  const required: ReleaseComponent[] = ["runtime", "lip_sync", "voice"];
  if (!databasePool()) {
    const approved = new Set([...releaseStore().releases.values()].filter((release) => release.tenantId === context.tenantId && release.approval === "approved").map((release) => release.component));
    return required.every((component) => approved.has(component));
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<{ component: ReleaseComponent }>("select distinct component from model_releases where approval_status = 'approved' and component = any($1::model_release_component[])", [required]);
    const approved = new Set(result.rows.map((row) => row.component));
    return required.every((component) => approved.has(component));
  });
}

function persistentRelease(row: PersistentReleaseRow): ModelRelease { return { id: row.id, tenantId: row.tenant_id, name: row.name, version: row.version, component: row.component, sourceCommit: row.source_commit, imageDigest: row.image_digest, artifactHash: row.artifact_hash, driverVersion: row.driver_version, license: row.license, rightsScope: row.rights_scope, notes: row.notes ?? undefined, approval: row.approval_status, approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined }; }
function databaseErrorCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
