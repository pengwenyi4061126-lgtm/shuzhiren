import type { RequestContext } from "@/lib/control-plane/auth-context";

export type AssetKind = "portrait" | "voice" | "product_clip" | "music";
export type AssetApproval = "pending" | "approved" | "revoked";
export type MediaAsset = { id: string; tenantId: string; kind: AssetKind; name: string; approval: AssetApproval; expiresAt?: string; rightsScope: string; source: string };
type AssetStore = { assets: Map<string, MediaAsset> };

declare global { var shuzhirenAssetStore: AssetStore | undefined; }

function assetStore(): AssetStore {
  globalThis.shuzhirenAssetStore ??= { assets: new Map([
    ["asset_portrait_demo", { id: "asset_portrait_demo", tenantId: "tenant_demo", kind: "portrait", name: "主播肖像授权素材", approval: "approved", expiresAt: "2027-10-31", rightsScope: "直播与录播数字人驱动", source: "授权书 #POR-2026-001" }],
    ["asset_voice_demo", { id: "asset_voice_demo", tenantId: "tenant_demo", kind: "voice", name: "主播声线参考", approval: "approved", expiresAt: "2027-10-31", rightsScope: "中文直播语音合成", source: "授权书 #VOC-2026-004" }],
    ["asset_clip_a102", { id: "asset_clip_a102", tenantId: "tenant_demo", kind: "product_clip", name: "洁面慕斯预制讲品", approval: "approved", rightsScope: "A-102 商品讲解", source: "内容审核 #CLP-2026-019" }],
    ["asset_bgm_demo", { id: "asset_bgm_demo", tenantId: "tenant_demo", kind: "music", name: "直播间背景音乐", approval: "approved", expiresAt: "2027-03-31", rightsScope: "店播背景音乐", source: "音乐授权 #MUS-2026-011" }]
  ]) };
  return globalThis.shuzhirenAssetStore;
}

export function listAssets(context: RequestContext) { return [...assetStore().assets.values()].filter((asset) => asset.tenantId === context.tenantId); }

export function hasApprovedLiveRights(context: RequestContext) {
  const assets = listAssets(context);
  const needed: AssetKind[] = ["portrait", "voice", "product_clip", "music"];
  const today = new Date().toISOString().slice(0, 10);
  return needed.every((kind) => assets.some((asset) => asset.kind === kind && asset.approval === "approved" && (!asset.expiresAt || asset.expiresAt >= today)));
}
