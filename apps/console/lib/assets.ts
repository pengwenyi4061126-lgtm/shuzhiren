import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { quarantineLiveRunsForRevocationInTransaction } from "@/lib/control-plane/governance-quarantine";

export type AssetKind = "portrait" | "voice" | "product_clip" | "music";
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
  approvedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
};
export type CreateMediaAssetInput = Pick<MediaAsset, "kind" | "name" | "rightsScope" | "source" | "objectKey" | "checksum"> & { expiresAt?: string };

type AssetStore = { assets: Map<string, MediaAsset> };
type PersistentAssetRow = {
  id: string;
  tenant_id: string;
  kind: AssetKind;
  name: string;
  approval_status: AssetApproval;
  expires_at: Date | string | null;
  rights_scope: string;
  source_ref: string;
  object_key: string;
  checksum: string;
  approved_at: Date | string | null;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
};
type BoundAssetRow = Pick<PersistentAssetRow, "kind" | "name" | "approval_status" | "expires_at">;

declare global { var shuzhirenAssetStore: AssetStore | undefined; }

function assetStore(): AssetStore {
  globalThis.shuzhirenAssetStore ??= { assets: new Map([
    ["asset_portrait_demo", { id: "asset_portrait_demo", tenantId: "tenant_demo", kind: "portrait", name: "主播肖像授权素材", approval: "approved", expiresAt: "2027-10-31", rightsScope: "直播与录播数字人驱动", source: "授权书 #POR-2026-001", objectKey: "demo/portrait.mp4", checksum: "demo-portrait", approvedAt: "2026-11-01T08:30:00.000Z" }],
    ["asset_voice_demo", { id: "asset_voice_demo", tenantId: "tenant_demo", kind: "voice", name: "主播声线参考", approval: "approved", expiresAt: "2027-10-31", rightsScope: "中文直播语音合成", source: "授权书 #VOC-2026-004", objectKey: "demo/voice.wav", checksum: "demo-voice", approvedAt: "2026-11-01T08:30:00.000Z" }],
    ["asset_clip_a102", { id: "asset_clip_a102", tenantId: "tenant_demo", kind: "product_clip", name: "洁面慕斯预制讲品", approval: "approved", rightsScope: "A-102 商品讲解", source: "内容审核 #CLP-2026-019", objectKey: "demo/a102.mp4", checksum: "demo-clip", approvedAt: "2026-11-01T08:30:00.000Z" }],
    ["asset_bgm_demo", { id: "asset_bgm_demo", tenantId: "tenant_demo", kind: "music", name: "直播间背景音乐", approval: "approved", expiresAt: "2027-03-31", rightsScope: "店播背景音乐", source: "音乐授权 #MUS-2026-011", objectKey: "demo/bgm.mp3", checksum: "demo-music", approvedAt: "2026-11-01T08:30:00.000Z" }]
  ]) };
  return globalThis.shuzhirenAssetStore;
}

const columns = "id, tenant_id, kind, name, approval_status, expires_at, rights_scope, source_ref, object_key, checksum, approved_at, revoked_at, revocation_reason";

export async function listAssets(context: RequestContext) {
  if (!databasePool()) return demoAssets(context);
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAssetRow>(
      `select ${columns} from media_assets order by created_at desc`,
    );
    return result.rows.map(persistentAsset);
  });
}

export async function createMediaAsset(context: RequestContext, input: CreateMediaAssetInput) {
  if (!databasePool()) {
    const asset: MediaAsset = { id: `asset_${crypto.randomUUID()}`, tenantId: context.tenantId, approval: "pending", ...input };
    assetStore().assets.set(asset.id, asset);
    return asset;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentAssetRow>(
      `insert into media_assets (tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8::date) returning ${columns}`,
      [context.tenantId, input.kind, input.name, input.objectKey, input.checksum, input.rightsScope, input.source, input.expiresAt ?? null]
    );
    return persistentAsset(result.rows[0]);
  });
}

export async function approveMediaAsset(context: RequestContext, assetId: string) {
  if (!databasePool()) {
    const asset = assetStore().assets.get(assetId);
    if (!asset || asset.tenantId !== context.tenantId || asset.approval !== "pending") throw new Response("Media asset not found or cannot be approved", { status: 409 });
    asset.approval = "approved";
    asset.approvedAt = new Date().toISOString();
    return asset;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<PersistentAssetRow>(
      `update media_assets set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 and approval_status = 'pending' returning ${columns}`,
      [assetId, actor.rows[0].id]
    );
    if (!result.rows[0]) throw new Response("Media asset not found or cannot be approved", { status: 409 });
    return persistentAsset(result.rows[0]);
  });
}

export async function revokeMediaAsset(context: RequestContext, assetId: string, reason: string) {
  if (!databasePool()) {
    const asset = assetStore().assets.get(assetId);
    if (!asset || asset.tenantId !== context.tenantId || asset.approval !== "approved") throw new Response("Media asset not found or cannot be revoked", { status: 409 });
    asset.approval = "revoked"; asset.revokedAt = new Date().toISOString(); asset.revocationReason = reason;
    return asset;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const actor = await syncActor(client, context);
    const result = await client.query<PersistentAssetRow>(`update media_assets set approval_status = 'revoked', revoked_by = $2, revoked_at = now(), revocation_reason = $3 where id = $1 and approval_status = 'approved' returning ${columns}`, [assetId, actor, reason]);
    if (!result.rows[0]) throw new Response("Media asset not found or cannot be revoked", { status: 409 });
    await quarantineLiveRunsForRevocationInTransaction(client, context, "media_asset", assetId, reason);
    return persistentAsset(result.rows[0]);
  });
}

export async function hasApprovedLiveRights(context: RequestContext) {
  return (await activeMediaAssetStatus(context)).active;
}

export async function currentApprovedMediaAssetsInTransaction(client: PoolClient) {
  const result = await client.query<PersistentAssetRow>(`select distinct on (kind) ${columns} from media_assets where approval_status = 'approved' and (expires_at is null or expires_at >= current_date) and kind = any($1::media_asset_kind[]) order by kind, approved_at desc, created_at desc`, [requiredLiveAssetKinds]);
  return new Map(result.rows.map((row) => [row.kind, persistentAsset(row)]));
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
  const result = await client.query<BoundAssetRow>("select binding.kind, asset.name, asset.approval_status, asset.expires_at from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id where binding.show_revision_id = $1 and binding.kind = any($2::media_asset_kind[])", [revisionId, requiredLiveAssetKinds]);
  const failures = requiredLiveAssetKinds.flatMap((kind) => {
    const matches = result.rows.filter((asset) => asset.kind === kind);
    if (matches.length !== 1) return [`${kind} 缺少唯一冻结授权素材`];
    const asset = matches[0];
    const expiresAt = asset.expires_at ? new Date(asset.expires_at).toISOString().slice(0, 10) : undefined;
    const expired = Boolean(expiresAt && expiresAt < new Date().toISOString().slice(0, 10));
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
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    name: row.name,
    approval: row.approval_status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString().slice(0, 10) : undefined,
    rightsScope: row.rights_scope,
    source: row.source_ref,
    objectKey: row.object_key,
    checksum: row.checksum,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
    revocationReason: row.revocation_reason ?? undefined
  };
}

async function syncActor(client: PoolClient, context: RequestContext) { return (await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role])).rows[0].id; }
