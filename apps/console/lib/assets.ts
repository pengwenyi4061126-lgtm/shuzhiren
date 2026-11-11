import type { PoolClient } from "pg";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { quarantineLiveRunsForRevocationInTransaction, type GovernanceQuarantineImpact } from "@/lib/control-plane/governance-quarantine";
import { verifyMediaAssetContent, type MediaContentVerification } from "@/lib/media-evidence";
import { verifiedStudioSamplePhoto, verifiedStudioSampleVoice } from "@/lib/verified-studio-sample";
import { preferProjectLiveAssets } from "@/lib/shared/live-asset-selection.mjs";

export type AssetKind = "portrait" | "portrait_photo" | "voice" | "product_clip" | "music" | "overlay_background";
export type AssetApproval = "pending" | "approved" | "revoked";
export const requiredLiveAssetKinds: AssetKind[] = ["portrait", "voice", "product_clip", "music"];
export type MediaAsset = {
  id: string;
  tenantId: string;
  kind: AssetKind;
  name: string;
  approval: AssetApproval;
  expiresAt?: string;
  rightsScope: string;
  source: string;
  objectKey: string;
  checksum: string;
  contentVerification?: MediaContentVerification;
  runtimeVoiceId?: string;
  approvedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
};
export type CreateMediaAssetInput = Pick<MediaAsset, "kind" | "name" | "rightsScope" | "source" | "objectKey" | "checksum" | "runtimeVoiceId"> & { expiresAt?: string };
export type MediaAssetRevocation = { asset: MediaAsset; impact: GovernanceQuarantineImpact };

type AssetStore = { assets: Map<string, MediaAsset> };
type PersistentAssetRow = {
  id: string;
  tenant_id: string;
  kind: AssetKind;
  name: string;
  approval_status: AssetApproval;
  expires_at: string | null;
  rights_scope: string;
  source_ref: string;
  object_key: string;
  checksum: string;
  runtime_voice_id: string | null;
  verified_object_version: string | null;
  verified_bytes: string | number | null;
  verified_content_type: string | null;
  verification_evidence_ref: string | null;
  verified_at: Date | string | null;
  approved_at: Date | string | null;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
};
type BoundAssetRow = Pick<PersistentAssetRow, "kind" | "name" | "approval_status" | "expires_at" | "runtime_voice_id" | "verified_object_version" | "verified_bytes" | "verified_content_type" | "verification_evidence_ref" | "verified_at">;

declare global { var shuzhirenAssetStore: AssetStore | undefined; }

const demoPortraitPhoto: MediaAsset = { id: "asset_portrait_photo_demo", tenantId: "tenant_demo", kind: "portrait_photo", name: "录播照片形象参考", approval: "approved", expiresAt: "2027-10-31", rightsScope: "照片播报录播制作", source: "授权书 #POR-PHOTO-2026-001", objectKey: "demo/portrait.jpg", checksum: "demo-portrait-photo", contentVerification: { objectVersion: "demo", bytes: 1, contentType: "image/jpeg", evidenceRef: "demo://media-evidence", verifiedAt: "2026-11-01T08:30:00.000Z" }, approvedAt: "2026-11-01T08:30:00.000Z" };
const verifiedDemoSamplePhoto: MediaAsset = {
  id: verifiedStudioSamplePhoto.assetId, tenantId: "tenant_demo", kind: "portrait_photo", name: "4090 已验证数字人照片样本", approval: "approved", expiresAt: "2027-10-31",
  rightsScope: "开发态录播制作与内部质量验收", source: "项目内置虚构 AI 数字人样本", objectKey: verifiedStudioSamplePhoto.objectKey, checksum: verifiedStudioSamplePhoto.checksum,
  contentVerification: { objectVersion: verifiedStudioSamplePhoto.objectVersion, bytes: verifiedStudioSamplePhoto.bytes, contentType: verifiedStudioSamplePhoto.contentType, evidenceRef: verifiedStudioSamplePhoto.evidenceRef, verifiedAt: "2026-11-11T07:51:00.000Z" }, approvedAt: "2026-11-11T07:51:00.000Z"
};
const verifiedDemoSampleVoice: MediaAsset = {
  id: verifiedStudioSampleVoice.assetId, tenantId: "tenant_demo", kind: "voice", name: "4090 CosyVoice 声线样本", approval: "approved", expiresAt: "2027-10-31",
  rightsScope: "开发态录播配音与 4090 试播验收", source: "LiveTalking / CosyVoice 已冻结声线 p0-test-voice", objectKey: verifiedStudioSampleVoice.objectKey, checksum: verifiedStudioSampleVoice.runtimeChecksum, runtimeVoiceId: verifiedStudioSampleVoice.runtimeVoiceId,
  contentVerification: { objectVersion: verifiedStudioSampleVoice.objectVersion, bytes: 1, contentType: verifiedStudioSampleVoice.contentType, evidenceRef: "evidence:runtime/p0-test-voice", verifiedAt: "2026-11-11T07:51:00.000Z" }, approvedAt: "2026-11-11T07:51:00.000Z"
};

function assetStore(): AssetStore {
  globalThis.shuzhirenAssetStore ??= { assets: new Map([
    ["asset_portrait_demo", { id: "asset_portrait_demo", tenantId: "tenant_demo", kind: "portrait", name: "主播肖像授权素材", approval: "approved", expiresAt: "2027-10-31", rightsScope: "直播与录播数字人驱动", source: "授权书 #POR-2026-001", objectKey: "demo/portrait.mp4", checksum: "demo-portrait", approvedAt: "2026-11-01T08:30:00.000Z" }],
    ["asset_portrait_photo_demo", demoPortraitPhoto],
    ["asset_voice_demo", { id: "asset_voice_demo", tenantId: "tenant_demo", kind: "voice", name: "主播声线参考", approval: "approved", expiresAt: "2027-10-31", rightsScope: "中文直播语音合成", source: "授权书 #VOC-2026-004", objectKey: "demo/voice.wav", checksum: "sha256:9b1f0c6c3d2a4e5f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f", runtimeVoiceId: "approved_voice_demo", approvedAt: "2026-11-01T08:30:00.000Z" }],
    [verifiedDemoSamplePhoto.id, verifiedDemoSamplePhoto],
    [verifiedDemoSampleVoice.id, verifiedDemoSampleVoice],
    ["asset_clip_a102", { id: "asset_clip_a102", tenantId: "tenant_demo", kind: "product_clip", name: "洁面慕斯预制讲品", approval: "approved", rightsScope: "A-102 商品讲解", source: "内容审核 #CLP-2026-019", objectKey: "demo/a102.mp4", checksum: "demo-clip", approvedAt: "2026-11-01T08:30:00.000Z" }],
    ["asset_bgm_demo", { id: "asset_bgm_demo", tenantId: "tenant_demo", kind: "music", name: "直播间背景音乐", approval: "approved", expiresAt: "2027-03-31", rightsScope: "店播背景音乐", source: "音乐授权 #MUS-2026-011", objectKey: "demo/bgm.mp3", checksum: "demo-music", approvedAt: "2026-11-01T08:30:00.000Z" }]
  ]) };
  if (!globalThis.shuzhirenAssetStore.assets.has(demoPortraitPhoto.id)) globalThis.shuzhirenAssetStore.assets.set(demoPortraitPhoto.id, demoPortraitPhoto);
  if (!globalThis.shuzhirenAssetStore.assets.has(verifiedDemoSamplePhoto.id)) globalThis.shuzhirenAssetStore.assets.set(verifiedDemoSamplePhoto.id, verifiedDemoSamplePhoto);
  if (!globalThis.shuzhirenAssetStore.assets.has(verifiedDemoSampleVoice.id)) globalThis.shuzhirenAssetStore.assets.set(verifiedDemoSampleVoice.id, verifiedDemoSampleVoice);
  return globalThis.shuzhirenAssetStore;
}

const columns = "id, tenant_id, kind, name, approval_status, expires_at, rights_scope, source_ref, object_key, checksum, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at, approved_at, revoked_at, revocation_reason";

export async function listAssets(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) return demoAssets(context);
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAssetRow>(
      `select ${columns} from media_assets order by created_at desc`,
    );
    return result.rows.map(persistentAsset);
  });
}

export async function createMediaAsset(context: RequestContext, input: CreateMediaAssetInput) {
  requireTenantWideAccess(context);
  const verification = await verifyMediaAssetContent(context, input);
  if (!databasePool()) {
    const asset: MediaAsset = { id: `asset_${crypto.randomUUID()}`, tenantId: context.tenantId, approval: "pending", ...input, contentVerification: verification };
    assetStore().assets.set(asset.id, asset);
    await recordAuditEvent(context, mediaAssetCreatedAudit(asset));
    return asset;
  }
  // The asset and its media_asset.created audit event commit together.
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAssetRow>(
      `insert into media_assets (tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, expires_at, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at) values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14::timestamptz) returning ${columns}`,
      [context.tenantId, input.kind, input.name, input.objectKey, input.checksum, input.rightsScope, input.source, input.expiresAt ?? null, input.runtimeVoiceId ?? null, verification.objectVersion, verification.bytes, verification.contentType, verification.evidenceRef, verification.verifiedAt]
    );
    const asset = persistentAsset(result.rows[0]);
    await recordAuditEventInTransaction(client, context, mediaAssetCreatedAudit(asset));
    return asset;
  });
}

function mediaAssetCreatedAudit(asset: MediaAsset): AuditEventInput {
  return { type: "media_asset.created", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, objectKey: asset.objectKey, objectVersion: asset.contentVerification?.objectVersion ?? "unverified", checksum: asset.checksum, verificationEvidenceRef: asset.contentVerification?.evidenceRef ?? "unverified" } };
}

function mediaAssetApprovedAudit(asset: MediaAsset): AuditEventInput {
  return { type: "media_asset.approved", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, objectVersion: asset.contentVerification?.objectVersion ?? "unverified", checksum: asset.checksum, verificationEvidenceRef: asset.contentVerification?.evidenceRef ?? "unverified" } };
}

function mediaAssetRevokedAudit(outcome: MediaAssetRevocation, reason: string): AuditEventInput {
  return { type: "media_asset.revoked", resource: "media_asset", resourceId: outcome.asset.id, detail: { kind: outcome.asset.kind, reason, quarantinedLiveRunCount: outcome.impact.liveRunIds.length, humanHandoffQueuedCount: outcome.impact.humanHandoffQueuedRunIds.length } };
}

export async function approveMediaAsset(context: RequestContext, assetId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const asset = assetStore().assets.get(assetId);
    if (!asset || asset.tenantId !== context.tenantId || asset.approval !== "pending") throw new Response("Media asset not found or cannot be approved", { status: 409 });
    asset.contentVerification = await verifyMediaAssetContent(context, asset);
    asset.approval = "approved";
    asset.approvedAt = new Date().toISOString();
    await recordAuditEvent(context, mediaAssetApprovedAudit(asset));
    return asset;
  }
  const candidate = await withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAssetRow>(`select ${columns} from media_assets where id = $1 and approval_status = 'pending'`, [assetId]);
    return result.rows[0] ? persistentAsset(result.rows[0]) : null;
  });
  if (!candidate) throw new Response("Media asset not found or cannot be approved", { status: 409 });
  const verification = await verifyMediaAssetContent(context, candidate);
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentAssetRow>(
      `update media_assets set approval_status = 'approved', approved_by = $2, approved_at = now(), verified_object_version = $3, verified_bytes = $4, verified_content_type = $5, verification_evidence_ref = $6, verified_at = $7::timestamptz where id = $1 and approval_status = 'pending' and object_key = $8 and checksum = $9 returning ${columns}`,
      [assetId, actor.rows[0].id, verification.objectVersion, verification.bytes, verification.contentType, verification.evidenceRef, verification.verifiedAt, candidate.objectKey, candidate.checksum]
    );
    if (!result.rows[0]) throw new Response("Media asset not found or cannot be approved", { status: 409 });
    const asset = persistentAsset(result.rows[0]);
    await recordAuditEventInTransaction(client, context, mediaAssetApprovedAudit(asset));
    return asset;
  });
}

export async function revokeMediaAsset(context: RequestContext, assetId: string, reason: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const asset = assetStore().assets.get(assetId);
    if (!asset || asset.tenantId !== context.tenantId || asset.approval !== "approved") throw new Response("Media asset not found or cannot be revoked", { status: 409 });
    asset.approval = "revoked"; asset.revokedAt = new Date().toISOString(); asset.revocationReason = reason;
    const outcome = { asset, impact: { liveRunIds: [], humanHandoffQueuedRunIds: [] } } satisfies MediaAssetRevocation;
    await recordAuditEvent(context, mediaAssetRevokedAudit(outcome, reason));
    return outcome;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const result = await client.query<PersistentAssetRow>(`update media_assets set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = $3 where id = $1 and approval_status = 'approved' returning ${columns}`, [assetId, actor, reason]);
    if (!result.rows[0]) throw new Response("Media asset not found or cannot be revoked", { status: 409 });
    const impact = await quarantineLiveRunsForRevocationInTransaction(client, context, "media_asset", assetId, reason);
    const outcome = { asset: persistentAsset(result.rows[0]), impact } satisfies MediaAssetRevocation;
    await recordAuditEventInTransaction(client, context, mediaAssetRevokedAudit(outcome, reason));
    return outcome;
  });
}

export async function hasApprovedLiveRights(context: RequestContext) {
  return (await activeMediaAssetStatus(context)).active;
}

export async function currentApprovedMediaAssetsInTransaction(client: PoolClient, preferredAssetIds: string[] = []) {
  const result = await client.query<PersistentAssetRow>(`select distinct on (kind) ${columns} from media_assets where approval_status = 'approved' and verified_object_version is not null and verified_bytes is not null and verified_content_type is not null and verification_evidence_ref is not null and verified_at is not null and (expires_at is null or expires_at >= current_date) and kind = any($1::media_asset_kind[]) order by kind, approved_at desc, created_at desc`, [requiredLiveAssetKinds]);
  const defaults = new Map(result.rows.map((row) => [row.kind, persistentAsset(row)]));
  const ids = [...new Set(preferredAssetIds)];
  if (!ids.length) return defaults;
  const preferred = await client.query<PersistentAssetRow>(`select ${columns} from media_assets where id::text = any($1::text[]) and approval_status = $2 and verified_object_version is not null and verified_bytes is not null and verified_content_type is not null and verification_evidence_ref is not null and verified_at is not null and (expires_at is null or expires_at >= current_date)`, [ids, "approved"]);
  if (preferred.rowCount !== ids.length) throw new Response("A selected asset is no longer approved, verified, or current", { status: 409 });
  return preferProjectLiveAssets(defaults, preferred.rows.map(persistentAsset));
}

export async function activeMediaAssetStatus(context: RequestContext, revisionId?: string) {
  if (!databasePool()) {
    const active = rightsAreComplete(demoAssets(context));
    return { active, detail: active ? "开发态肖像、声线、商品视频和音乐授权均有效" : "缺少有效的肖像、声线、商品视频或音乐授权" };
  }
  return withTenantTransaction(context.tenantId, async (client) => activeMediaAssetStatusInTransaction(client, revisionId));
}

export async function activeMediaAssetStatusInTransaction(client: PoolClient, revisionId?: string) {
  if (!revisionId) {
    const assets = await currentApprovedMediaAssetsInTransaction(client);
    const missing = requiredLiveAssetKinds.filter((kind) => !assets.has(kind));
    return missing.length === 0 ? { active: true, detail: "肖像、声线、商品视频和音乐授权均有效" } : { active: false, detail: `缺少有效授权：${missing.join("、")}` };
  }
  const result = await client.query<BoundAssetRow & { checksum: string }>("select binding.kind, asset.name, asset.approval_status, asset.expires_at, asset.runtime_voice_id, asset.checksum, asset.verified_object_version, asset.verified_bytes, asset.verified_content_type, asset.verification_evidence_ref, asset.verified_at from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id where binding.show_revision_id = $1 and binding.kind = any($2::media_asset_kind[])", [revisionId, requiredLiveAssetKinds]);
  const failures = requiredLiveAssetKinds.flatMap((kind) => {
    const matches = result.rows.filter((asset) => asset.kind === kind);
    if (matches.length !== 1) return [`${kind} 缺少唯一冻结授权素材`];
    const asset = matches[0];
    const expiresAt = asset.expires_at ?? undefined;
    const expired = Boolean(expiresAt && expiresAt < new Date().toISOString().slice(0, 10));
    if (!contentVerificationPresent(asset)) return [`${kind} ${asset.name} 缺少受控对象内容验证`];
    if (kind === "voice" && !isRuntimeVoiceId(asset.runtime_voice_id)) return [`voice ${asset.name} 缺少有效运行时声线标识`];
    if (kind === "voice" && !isVoiceChecksum(asset.checksum)) return [`voice ${asset.name} 缺少有效声线校验和`];
    return asset.approval_status === "approved" && !expired ? [] : [`${kind} ${asset.name} 已撤销、未批准或授权已到期`];
  });
  return failures.length === 0 ? { active: true, detail: "已冻结肖像、声线、商品视频和音乐授权均有效" } : { active: false, detail: failures.join("；") };
}

function demoAssets(context: RequestContext) {
  return [...assetStore().assets.values()].filter((asset) => asset.tenantId === context.tenantId);
}

function rightsAreComplete(assets: MediaAsset[]) {
  const today = new Date().toISOString().slice(0, 10);
  return requiredLiveAssetKinds.every((kind) => assets.some((asset) => asset.kind === kind && asset.approval === "approved" && (!asset.expiresAt || asset.expiresAt >= today)));
}

function persistentAsset(row: PersistentAssetRow): MediaAsset {
  const contentVerification = contentVerificationPresent(row)
    ? { objectVersion: row.verified_object_version!, bytes: Number(row.verified_bytes), contentType: row.verified_content_type!, evidenceRef: row.verification_evidence_ref!, verifiedAt: new Date(row.verified_at!).toISOString() }
    : undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    name: row.name,
    approval: row.approval_status,
    expiresAt: row.expires_at ?? undefined,
    rightsScope: row.rights_scope,
    source: row.source_ref,
    objectKey: row.object_key,
    checksum: row.checksum,
    contentVerification,
    runtimeVoiceId: row.runtime_voice_id ?? undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
    revocationReason: row.revocation_reason ?? undefined
  };
}

// The approved voice frozen with a run's revision. The Runtime Gateway synthesizes program scripts and speech
// with CosyVoice only for this voice: runtime_voice_id selects it and voice_checksum (the asset checksum,
// sha256:<64 hex>) must match the reference audio in the Gateway's voice library.
export type RuntimeVoiceBinding = { runtimeVoiceId: string; voiceChecksum: string };
export const runtimeVoiceBindingUnavailable = "runtime_voice_binding_unavailable";

export async function runtimeVoiceForRun(context: RequestContext, revisionId: string): Promise<RuntimeVoiceBinding> {
  if (!databasePool()) {
    const voice = demoAssets(context).find((asset) => asset.kind === "voice" && asset.approval === "approved" && isRuntimeVoiceId(asset.runtimeVoiceId) && isVoiceChecksum(asset.checksum));
    if (!voice?.runtimeVoiceId) throw new Response("Frozen voice asset has no approved runtime voice", { status: 409, statusText: runtimeVoiceBindingUnavailable });
    return { runtimeVoiceId: voice.runtimeVoiceId, voiceChecksum: voice.checksum };
  }
  return withTenantTransaction(context.tenantId, async (client) => runtimeVoiceForRunInTransaction(client, revisionId));
}

export async function runtimeVoiceForRunInTransaction(client: PoolClient, revisionId: string): Promise<RuntimeVoiceBinding> {
  const result = await client.query<BoundAssetRow & { checksum: string }>("select binding.kind, asset.name, asset.approval_status, asset.expires_at, asset.runtime_voice_id, asset.checksum, asset.verified_object_version, asset.verified_bytes, asset.verified_content_type, asset.verification_evidence_ref, asset.verified_at from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id where binding.show_revision_id = $1 and binding.kind = 'voice'", [revisionId]);
  const asset = result.rows[0];
  const expired = asset?.expires_at && asset.expires_at < new Date().toISOString().slice(0, 10);
  if (!asset || asset.approval_status !== "approved" || expired || !contentVerificationPresent(asset) || !isRuntimeVoiceId(asset.runtime_voice_id) || !isVoiceChecksum(asset.checksum)) throw new Response("Frozen voice asset is not approved for runtime speech", { status: 409, statusText: runtimeVoiceBindingUnavailable });
  return { runtimeVoiceId: asset.runtime_voice_id, voiceChecksum: asset.checksum };
}

export function isRuntimeVoiceId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
export function isVoiceChecksum(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value); }

function contentVerificationPresent(value: Pick<PersistentAssetRow, "verified_object_version" | "verified_bytes" | "verified_content_type" | "verification_evidence_ref" | "verified_at">): value is Pick<PersistentAssetRow, "verified_object_version" | "verified_content_type" | "verification_evidence_ref" | "verified_at"> & { verified_bytes: string | number } {
  return Boolean(value.verified_object_version && value.verified_content_type && value.verification_evidence_ref && value.verified_at && value.verified_bytes !== null && Number(value.verified_bytes) > 0);
}

async function syncActor(client: PoolClient, context: RequestContext) { return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id; }
