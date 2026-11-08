import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { currentDemoLexicon, currentLexiconInTransaction, policyRulesForRevisionInTransaction } from "@/lib/prohibited-terms";
import { canonicalJson } from "@/lib/canonical-json.mjs";
import { guardBroadcastText } from "@/lib/shared/broadcast-guard.mjs";
import { runtimeGatewayDemoMode, runtimeGatewayHealth } from "@/lib/runtime-gateway";

export const OVERLAY_CAPTION_POSITIONS = ["bottom_band", "top_band"] as const;
export const OVERLAY_PRODUCT_CARD_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right"] as const;
export const OVERLAY_BACKGROUND_MODES = ["none", "canvas", "chroma_key"] as const;
export const OVERLAY_AVATAR_ANCHORS = ["left", "center", "right"] as const;
export const AIGC_LABEL_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

export type OverlayBackgroundMode = typeof OVERLAY_BACKGROUND_MODES[number];
export type OverlayBackgroundOptions = Record<string, never>
  | { avatarAnchor: typeof OVERLAY_AVATAR_ANCHORS[number]; avatarScalePermille: number }
  | { keyColor: string; tolerance: number };
export type OverlayConfig = {
  captionEnabled: boolean;
  captionPosition: typeof OVERLAY_CAPTION_POSITIONS[number];
  productCardEnabled: boolean;
  productCardAnchor: typeof OVERLAY_PRODUCT_CARD_ANCHORS[number];
  priceStickerEnabled: boolean;
  backgroundMode: OverlayBackgroundMode;
  backgroundMediaAssetId: string | null;
  backgroundOptions: OverlayBackgroundOptions;
};
export type OverlayProductVersion = { id: string; revision: number; name: string; priceCent: number; validUntil: string | null };
export type OverlayBackgroundAsset = { id: string; checksum: string; approval?: string; expiresAt?: string };
export type OverlayScene = {
  version: 1;
  revisionId: string;
  caption: { enabled: boolean; position: OverlayConfig["captionPosition"] };
  productCard: { anchor: OverlayConfig["productCardAnchor"]; title: string } | null;
  priceSticker: { priceText: string; note: string; validUntil: string | null } | null;
  background: { mode: "none" } | ({ mode: "canvas" | "chroma_key"; assetSha256: string } & Record<string, unknown>);
  product: { productVersionId: string; revision: number } | null;
};
export type OverlayReadiness = { passed: boolean; detail: string };

type OverlayRow = {
  tenant_id: string;
  show_revision_id: string;
  caption_enabled: boolean;
  caption_position: string;
  product_card_enabled: boolean;
  product_card_anchor: string;
  price_sticker_enabled: boolean;
  background_mode: string;
  background_media_asset_id: string | null;
  background_options: unknown;
  scene_json: string | null;
  scene_sha256: string | null;
  frozen_at: Date | string | null;
  updated_by?: string;
  updated_at?: Date | string;
};
type ProductRow = { id: string; revision: number; name: string; approval_status: string; facts: unknown };
type AssetRow = { id: string; kind: string; approval_status: string; expires_at: Date | string | null; checksum: string };
type DemoOverlayRevision = { runId: string; tenantId: string; editable: boolean };
type DemoOverlayRecord = OverlayConfig & { sceneJson: string | null; sceneSha256: string | null; frozenAt: string | null };
type DemoOverlayStore = { revisions: Map<string, DemoOverlayRevision>; overlays: Map<string, DemoOverlayRecord> };

declare global { var shuzhirenOverlayStore: DemoOverlayStore | undefined; }

const defaultOverlayConfig: OverlayConfig = {
  captionEnabled: false,
  captionPosition: "bottom_band",
  productCardEnabled: false,
  productCardAnchor: "middle-right",
  priceStickerEnabled: false,
  backgroundMode: "none",
  backgroundMediaAssetId: null,
  backgroundOptions: {}
};
const PRICE_STICKER_NOTE = "价格以下单页为准";
const CONTROL_CHARACTER = /\p{C}/u;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}

function isEnabled(config: OverlayConfig) {
  return config.captionEnabled || config.productCardEnabled || config.priceStickerEnabled || config.backgroundMode !== "none";
}

function formatPriceCent(priceCent: number) {
  const text = `¥${Math.floor(priceCent / 100)}.${String(priceCent % 100).padStart(2, "0")}`;
  if ([...text].length > 16) throw new TypeError("Approved product version price exceeds the overlay text limit");
  return text;
}

function overlayStore(): DemoOverlayStore {
  globalThis.shuzhirenOverlayStore ??= { revisions: new Map(), overlays: new Map() };
  return globalThis.shuzhirenOverlayStore;
}

function normalizeBackgroundOptions(mode: OverlayBackgroundMode, value: unknown): OverlayBackgroundOptions | null {
  if (!isRecord(value)) return null;
  if (mode === "none") return Object.keys(value).length === 0 ? {} : null;
  if (mode === "canvas") {
    if (!isOneOf(value.avatarAnchor, OVERLAY_AVATAR_ANCHORS) || !Number.isInteger(value.avatarScalePermille) || Number(value.avatarScalePermille) < 500 || Number(value.avatarScalePermille) > 1000) return null;
    return { avatarAnchor: value.avatarAnchor, avatarScalePermille: Number(value.avatarScalePermille) };
  }
  if (typeof value.keyColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.keyColor) || !Number.isInteger(value.tolerance) || Number(value.tolerance) < 0 || Number(value.tolerance) > 255) return null;
  return { keyColor: value.keyColor, tolerance: Number(value.tolerance) };
}

export function overlayConfigProblem(value: unknown): string | null {
  if (!isRecord(value)) return "画面层配置必须是对象";
  if (typeof value.captionEnabled !== "boolean") return "字幕开关无效";
  if (!isOneOf(value.captionPosition, OVERLAY_CAPTION_POSITIONS)) return "字幕位置无效";
  if (typeof value.productCardEnabled !== "boolean") return "商品卡开关无效";
  if (!isOneOf(value.productCardAnchor, OVERLAY_PRODUCT_CARD_ANCHORS)) return "商品卡锚点无效";
  if (typeof value.priceStickerEnabled !== "boolean") return "价格贴片开关无效";
  if (value.priceStickerEnabled && !value.productCardEnabled) return "启用价格贴片时必须启用商品卡";
  if (!isOneOf(value.backgroundMode, OVERLAY_BACKGROUND_MODES)) return "背景方式无效";
  if (value.backgroundMediaAssetId !== null && (typeof value.backgroundMediaAssetId !== "string" || value.backgroundMediaAssetId.length < 1 || value.backgroundMediaAssetId.length > 128 || CONTROL_CHARACTER.test(value.backgroundMediaAssetId))) return "背景素材无效";
  if (value.backgroundMode === "none" && value.backgroundMediaAssetId !== null) return "无背景时不能绑定背景素材";
  if (value.backgroundMode !== "none" && value.backgroundMediaAssetId === null) return "启用背景时必须选择背景素材";
  if (!normalizeBackgroundOptions(value.backgroundMode, value.backgroundOptions)) {
    if (value.backgroundMode === "canvas") return "画布背景必须设置有效的 avatarAnchor 与 avatarScalePermille（500–1000）";
    if (value.backgroundMode === "chroma_key") return "色键背景必须设置 #RRGGBB keyColor 与 0–255 tolerance";
    return "无背景时 backgroundOptions 必须为空对象";
  }
  return null;
}

export function parseOverlayConfigInput(value: unknown): OverlayConfig | null {
  if (overlayConfigProblem(value)) return null;
  const input = value as Record<string, unknown>;
  const backgroundMode = input.backgroundMode as OverlayBackgroundMode;
  return {
    captionEnabled: input.captionEnabled as boolean,
    captionPosition: input.captionPosition as OverlayConfig["captionPosition"],
    productCardEnabled: input.productCardEnabled as boolean,
    productCardAnchor: input.productCardAnchor as OverlayConfig["productCardAnchor"],
    priceStickerEnabled: input.priceStickerEnabled as boolean,
    backgroundMode,
    backgroundMediaAssetId: input.backgroundMediaAssetId as string | null,
    backgroundOptions: normalizeBackgroundOptions(backgroundMode, input.backgroundOptions)!
  };
}

function overlayConfigFromRow(row: OverlayRow): OverlayConfig | null {
  return parseOverlayConfigInput({
    captionEnabled: row.caption_enabled,
    captionPosition: row.caption_position,
    productCardEnabled: row.product_card_enabled,
    productCardAnchor: row.product_card_anchor,
    priceStickerEnabled: row.price_sticker_enabled,
    backgroundMode: row.background_mode,
    backgroundMediaAssetId: row.background_media_asset_id,
    backgroundOptions: row.background_options
  });
}

export function buildOverlayScene(revisionId: string, config: OverlayConfig, product: OverlayProductVersion | null, asset: OverlayBackgroundAsset | null): OverlayScene {
  if (typeof revisionId !== "string" || !revisionId.trim() || [...revisionId].length > 64 || CONTROL_CHARACTER.test(revisionId)) throw new TypeError("Overlay revision id is invalid");
  let productScene: OverlayScene["product"] = null;
  let productCard: OverlayScene["productCard"] = null;
  let priceSticker: OverlayScene["priceSticker"] = null;
  if (config.productCardEnabled || config.priceStickerEnabled) {
    if (!product || !product.id || !Number.isSafeInteger(product.revision) || product.revision < 1 || !product.name.trim() || CONTROL_CHARACTER.test(product.name) || [...product.name].length > 60) throw new TypeError("Approved primary product version is required for the overlay scene");
    if (!Number.isSafeInteger(product.priceCent) || product.priceCent < 0) throw new TypeError("Approved product version price is invalid");
    productScene = { productVersionId: product.id, revision: product.revision };
    if (config.productCardEnabled) productCard = { anchor: config.productCardAnchor, title: product.name };
    if (config.priceStickerEnabled) priceSticker = { priceText: formatPriceCent(product.priceCent), note: PRICE_STICKER_NOTE, validUntil: product.validUntil };
  }

  let background: OverlayScene["background"] = { mode: "none" };
  if (config.backgroundMode !== "none") {
    const match = asset?.checksum.match(/^sha256:([0-9a-f]{64})$/i);
    if (!asset || asset.id !== config.backgroundMediaAssetId || !match) throw new TypeError("Approved overlay background asset checksum is invalid");
    background = config.backgroundMode === "canvas"
      ? { mode: "canvas", assetSha256: match[1].toLowerCase(), ...(config.backgroundOptions as Extract<OverlayBackgroundOptions, { avatarAnchor: string }>) }
      : { mode: "chroma_key", assetSha256: match[1].toLowerCase(), ...(config.backgroundOptions as Extract<OverlayBackgroundOptions, { keyColor: string }>) };
  }

  return {
    version: 1,
    revisionId,
    caption: { enabled: config.captionEnabled, position: config.captionPosition },
    productCard,
    priceSticker,
    background,
    product: productScene
  };
}

export function overlayAigcConflicts(config: OverlayConfig, aigcPosition: unknown): boolean {
  if (!isOneOf(aigcPosition, AIGC_LABEL_POSITIONS)) return false;
  if (config.productCardEnabled && config.productCardAnchor === aigcPosition) return true;
  if (config.captionEnabled && ((config.captionPosition === "bottom_band" && aigcPosition.startsWith("bottom-")) || (config.captionPosition === "top_band" && aigcPosition.startsWith("top-")))) return true;
  return false;
}

export type OverlayReadinessInput = {
  config: OverlayConfig | null;
  overlayPresent?: boolean;
  sceneJson?: string | null;
  sceneSha256?: string | null;
  backgroundApproval?: string | null;
  backgroundExpiresAt?: string | Date | null;
  priceValidUntil?: string | Date | null;
  demoGateway?: boolean;
  gatewayOverlay?: { supported?: unknown; aigcPosition?: unknown } | null;
  now?: Date;
};

export function evaluateOverlayReadiness(input: OverlayReadinessInput): OverlayReadiness {
  const config = input.config;
  if (!config) {
    if (input.overlayPresent || input.sceneJson || input.sceneSha256) return { passed: false, detail: "画面层配置未冻结或已损坏" };
    return { passed: true, detail: "未启用画面层" };
  }
  if (!isEnabled(config)) return { passed: true, detail: "未启用画面层" };
  const sceneDigest = typeof input.sceneJson === "string" && input.sceneSha256
    ? createHash("sha256").update(input.sceneJson, "utf8").digest("hex")
    : null;
  if (!input.sceneSha256 || !SHA256.test(input.sceneSha256) || !input.sceneJson || input.sceneJson.length > 8192 || sceneDigest !== input.sceneSha256) return { passed: false, detail: "画面层配置未冻结或已损坏" };

  const now = input.now ?? new Date();
  if (config.backgroundMode !== "none") {
    const expiresAt = input.backgroundExpiresAt === null || input.backgroundExpiresAt === undefined ? null : new Date(input.backgroundExpiresAt);
    if (input.backgroundApproval !== "approved" || (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < startOfUtcDay(now).getTime()))) return { passed: false, detail: "背景素材授权无效" };
  }
  if (config.priceStickerEnabled && input.priceValidUntil) {
    const validUntil = new Date(input.priceValidUntil);
    if (!Number.isFinite(validUntil.getTime()) || now.getTime() > validUntil.getTime()) return { passed: false, detail: "商品价格有效期已过，请发起节目变更" };
  }
  if (input.demoGateway) return { passed: true, detail: "演示网关：未连接 LiveTalking，画面层未经运行时核验" };
  if (!input.gatewayOverlay || input.gatewayOverlay.supported !== true || !isOneOf(input.gatewayOverlay.aigcPosition, AIGC_LABEL_POSITIONS)) return { passed: false, detail: "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）" };
  if (overlayAigcConflicts(config, input.gatewayOverlay.aigcPosition)) return { passed: false, detail: "画面层位置与 AIGC 角标位置冲突" };
  return { passed: true, detail: "画面层已冻结（字幕、商品卡、背景）" };
}

export function evaluateOverlayReport(health: unknown, expected: Omit<OverlayReadinessInput, "gatewayOverlay">): OverlayReadiness {
  if (!health || typeof health !== "object") return { passed: false, detail: "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）" };
  const overlay = (health as { dependencies?: { livetalking?: { overlay?: { supported?: unknown; aigc_position?: unknown } } } }).dependencies?.livetalking?.overlay;
  if (!overlay || overlay.supported !== true) return { passed: false, detail: "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）" };
  return evaluateOverlayReadiness({ ...expected, gatewayOverlay: { supported: overlay.supported, aigcPosition: overlay.aigc_position } });
}

export async function evaluateOverlayReadinessForRun(client: PoolClient | null, runId: string, demoRevisionId?: string): Promise<OverlayReadiness> {
  let expected: Omit<OverlayReadinessInput, "gatewayOverlay">;
  if (client) {
    const result = await client.query<OverlayRow & { run_revision_id: string; background_approval: string | null; background_expires_at: Date | string | null; price_valid_until: string | null }>(
      `select r.show_revision_id as run_revision_id, o.*, asset.approval_status as background_approval, asset.expires_at as background_expires_at, pv.facts->>'validUntil' as price_valid_until
       from live_runs r left join show_revision_overlays o on o.show_revision_id = r.show_revision_id and o.tenant_id = r.tenant_id
       left join media_assets asset on asset.id = o.background_media_asset_id
       left join show_revision_product_versions binding on binding.show_revision_id = r.show_revision_id and binding.tenant_id = r.tenant_id and binding.slot_key = 'primary'
       left join product_versions pv on pv.id = binding.product_version_id and pv.tenant_id = binding.tenant_id where r.id = $1`, [runId]);
    const row = result.rows[0];
    if (!row || !row.run_revision_id) return { passed: false, detail: "Live run not found" };
    expected = { config: row.background_mode === null ? null : overlayConfigFromRow(row), overlayPresent: row.background_mode !== null, sceneJson: row.scene_json, sceneSha256: row.scene_sha256, backgroundApproval: row.background_approval, backgroundExpiresAt: row.background_expires_at, priceValidUntil: row.price_valid_until };
  } else {
    const program = demoProgramRevision(runId);
    const revisionId = demoRevisionId ?? program?.revisionId;
    if (!revisionId) return { passed: true, detail: "未启用画面层" };
    const record = overlayStore().overlays.get(revisionId);
    const config = getDemoOverlayConfig(revisionId);
    const versionId = (globalThis as typeof globalThis & { shuzhirenProgramStore?: { programs: Map<string, { segments?: Array<{ productVersionId?: string }> }> } }).shuzhirenProgramStore?.programs.get(runId)?.segments?.find((segment) => segment.productVersionId)?.productVersionId;
    const versions = (globalThis as typeof globalThis & { shuzhirenCatalog?: { products: Map<string, { versions: Array<{ id: string; facts: { validUntil?: string } }> }> } }).shuzhirenCatalog?.products;
    const version = [...(versions?.values() ?? [])].flatMap((product) => product.versions).find((item) => item.id === versionId);
    const asset = record?.backgroundMediaAssetId ? (globalThis as typeof globalThis & { shuzhirenAssetStore?: { assets: Map<string, { approval: string; expiresAt?: string }> } }).shuzhirenAssetStore?.assets.get(record.backgroundMediaAssetId) : undefined;
    expected = { config, overlayPresent: Boolean(record), sceneJson: record?.sceneJson, sceneSha256: record?.sceneSha256, backgroundApproval: asset?.approval, backgroundExpiresAt: asset?.expiresAt, priceValidUntil: version?.facts.validUntil };
  }
  const configured = evaluateOverlayReadiness({ ...expected, demoGateway: true });
  if (!configured.passed || configured.detail === "未启用画面层") return configured;
  if (runtimeGatewayDemoMode()) return configured;
  try { return evaluateOverlayReport(await runtimeGatewayHealth({ timeoutMs: 5_000, acceptDegraded: true }), expected); }
  catch { return { passed: false, detail: "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）" }; }
}

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) throw new TypeError("Product validUntil must be a date or null");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Product validUntil must be a valid date or null");
  return date.toISOString();
}

function asProduct(row: ProductRow | undefined): OverlayProductVersion | null {
  if (!row || row.approval_status !== "approved" || !isRecord(row.facts)) return null;
  const priceCent = row.facts.priceCent;
  if (typeof priceCent !== "number" || !Number.isSafeInteger(priceCent) || priceCent < 0) return null;
  try {
    return { id: row.id, revision: row.revision, name: row.name, priceCent, validUntil: normalizeDate(row.facts.validUntil) };
  } catch {
    return null;
  }
}

function overlayUnavailable() {
  return new Response("Approved overlay product or background evidence is unavailable", { status: 422, statusText: "overlay_scene_unavailable" });
}

function overlayTextBlocked() {
  return new Response("Overlay text is blocked by the broadcast policy", { status: 422, statusText: "overlay_text_policy_blocked" });
}

function checkOverlayText(text: string, maxLength: number, policyRules: Awaited<ReturnType<typeof policyRulesForRevisionInTransaction>>, lexicon: Awaited<ReturnType<typeof currentLexiconInTransaction>>) {
  if (!guardBroadcastText(text, { policyRules, lexicon, maxLength }).allowed) throw overlayTextBlocked();
}

export async function freezeOverlaySceneInTransaction(client: PoolClient, revisionId: string) {
  const result = await client.query<OverlayRow>("select * from show_revision_overlays where show_revision_id = $1 for update", [revisionId]);
  const row = result.rows[0];
  if (!row) return null;
  const config = overlayConfigFromRow(row);
  if (!config) throw overlayUnavailable();
  if (!isEnabled(config)) return null;

  let product: OverlayProductVersion | null = null;
  if (config.productCardEnabled || config.priceStickerEnabled) {
    const selected = await client.query<ProductRow>(
      `select pv.id, pv.revision, p.name, pv.approval_status, pv.facts
       from show_revision_product_versions binding
       join product_versions pv on pv.tenant_id = binding.tenant_id and pv.id = binding.product_version_id
       join products p on p.tenant_id = pv.tenant_id and p.id = pv.product_id
       where binding.show_revision_id = $1 and binding.slot_key = 'primary'`,
      [revisionId]
    );
    product = asProduct(selected.rows[0]);
    if (!product) throw overlayUnavailable();
  }

  let asset: OverlayBackgroundAsset | null = null;
  if (config.backgroundMode !== "none") {
    const selected = await client.query<AssetRow>("select id, kind, approval_status, expires_at, checksum from media_assets where id = $1", [config.backgroundMediaAssetId]);
    const candidate = selected.rows[0];
    const expiresAt = candidate?.expires_at ? new Date(candidate.expires_at) : null;
    const expired = expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < startOfUtcDay(new Date()).getTime());
    if (!candidate || candidate.kind !== "overlay_background" || candidate.approval_status !== "approved" || expired) throw overlayUnavailable();
    asset = candidate;
  }

  const policyRules = await policyRulesForRevisionInTransaction(client, revisionId);
  const lexicon = await currentLexiconInTransaction(client);
  if (product && config.productCardEnabled) checkOverlayText(product.name, 120, policyRules, lexicon);
  if (product && config.priceStickerEnabled) {
    const priceText = formatPriceCent(product.priceCent);
    checkOverlayText(priceText, 16, policyRules, lexicon);
    checkOverlayText(PRICE_STICKER_NOTE, 40, policyRules, lexicon);
  }

  let sceneJson: string;
  try {
    sceneJson = canonicalJson(buildOverlayScene(revisionId, config, product, asset));
  } catch {
    throw overlayUnavailable();
  }
  const sceneSha256 = createHash("sha256").update(sceneJson, "utf8").digest("hex");
  if (sceneJson.length > 8192) throw overlayUnavailable();
  const frozen = await client.query<{ frozen_at: Date | string }>(
    "update show_revision_overlays set scene_json = $2, scene_sha256 = $3, frozen_at = now() where tenant_id = $4 and show_revision_id = $1 and scene_sha256 is null returning frozen_at",
    [revisionId, sceneJson, sceneSha256, row.tenant_id]
  );
  if (!frozen.rows[0]) throw new Response("Overlay configuration changed before it could be frozen", { status: 409, statusText: "overlay_config_changed" });
  return { sceneJson, sceneSha256, frozenAt: new Date(frozen.rows[0].frozen_at).toISOString() };
}

export function freezeDemoOverlayScene(
  runId: string,
  tenantId: string,
  revisionId: string,
  product: OverlayProductVersion | null,
  asset: OverlayBackgroundAsset | null
) {
  const store = overlayStore();
  const revision = store.revisions.get(revisionId);
  const record = store.overlays.get(revisionId);
  if (!record) return null;
  if (!revision || revision.runId !== runId || revision.tenantId !== tenantId) throw new Response("Overlay configuration is not editable", { status: 409, statusText: "overlay_not_editable" });
  if (record.sceneJson && record.sceneSha256 && record.frozenAt) return { sceneJson: record.sceneJson, sceneSha256: record.sceneSha256, frozenAt: record.frozenAt };
  if (record.sceneJson || record.sceneSha256 || record.frozenAt) throw overlayUnavailable();
  const config = parseOverlayConfigInput(record);
  if (!config) throw overlayUnavailable();
  if (!isEnabled(config)) return null;
  if ((config.productCardEnabled || config.priceStickerEnabled) && !product) throw overlayUnavailable();
  if (config.backgroundMode !== "none") {
    const expiresAt = asset?.expiresAt ? new Date(asset.expiresAt) : null;
    const expired = expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < startOfUtcDay(new Date()).getTime());
    if (!asset || asset.id !== config.backgroundMediaAssetId || asset.approval !== "approved" || expired || !/^sha256:[0-9a-f]{64}$/i.test(asset.checksum)) throw overlayUnavailable();
  }
  const lexicon = currentDemoLexicon(tenantId);
  if (product && config.productCardEnabled) checkOverlayText(product.name, 120, [], lexicon);
  if (product && config.priceStickerEnabled) {
    checkOverlayText(formatPriceCent(product.priceCent), 16, [], lexicon);
    checkOverlayText(PRICE_STICKER_NOTE, 40, [], lexicon);
  }
  let sceneJson: string;
  try {
    sceneJson = canonicalJson(buildOverlayScene(revisionId, config, product, asset));
  } catch {
    throw overlayUnavailable();
  }
  if (sceneJson.length > 8192) throw overlayUnavailable();
  const sceneSha256 = createHash("sha256").update(sceneJson, "utf8").digest("hex");
  const frozenAt = new Date().toISOString();
  store.overlays.set(revisionId, { ...config, sceneJson, sceneSha256, frozenAt });
  return { sceneJson, sceneSha256, frozenAt };
}

export function cloneDemoOverlayConfig(sourceRevisionId: string, targetRevisionId: string, runId: string, tenantId: string) {
  const store = overlayStore();
  const sourceRevision = store.revisions.get(sourceRevisionId);
  const source = store.overlays.get(sourceRevisionId);
  if (!source || !sourceRevision || sourceRevision.runId !== runId || sourceRevision.tenantId !== tenantId) return null;
  store.revisions.set(targetRevisionId, { runId, tenantId, editable: true });
  const config: OverlayConfig = {
    captionEnabled: source.captionEnabled,
    captionPosition: source.captionPosition,
    productCardEnabled: source.productCardEnabled,
    productCardAnchor: source.productCardAnchor,
    priceStickerEnabled: source.priceStickerEnabled,
    backgroundMode: source.backgroundMode,
    backgroundMediaAssetId: source.backgroundMediaAssetId,
    backgroundOptions: source.backgroundOptions
  };
  store.overlays.set(targetRevisionId, { ...config, backgroundOptions: { ...config.backgroundOptions }, sceneJson: null, sceneSha256: null, frozenAt: null });
  return { ...config, backgroundOptions: { ...config.backgroundOptions } };
}

export function registerDemoOverlayConfig(runId: string, tenantId: string, revisionId: string, config: OverlayConfig, editable: boolean) {
  const store = overlayStore();
  store.revisions.set(revisionId, { runId, tenantId, editable });
  store.overlays.set(revisionId, { ...config, backgroundOptions: { ...config.backgroundOptions }, sceneJson: null, sceneSha256: null, frozenAt: null });
}

export function setDemoOverlayEditable(revisionId: string, editable: boolean) {
  const revision = overlayStore().revisions.get(revisionId);
  if (revision) overlayStore().revisions.set(revisionId, { ...revision, editable });
}

export function getDemoOverlayConfig(revisionId: string): OverlayConfig | null {
  const record = overlayStore().overlays.get(revisionId);
  return record ? overlayConfigFromRow({
    tenant_id: "",
    show_revision_id: revisionId,
    caption_enabled: record.captionEnabled,
    caption_position: record.captionPosition,
    product_card_enabled: record.productCardEnabled,
    product_card_anchor: record.productCardAnchor,
    price_sticker_enabled: record.priceStickerEnabled,
    background_mode: record.backgroundMode,
    background_media_asset_id: record.backgroundMediaAssetId,
    background_options: record.backgroundOptions,
    scene_json: null,
    scene_sha256: null,
    frozen_at: null
  }) : null;
}

const OVERLAY_COLUMNS = "tenant_id, show_revision_id, caption_enabled, caption_position, product_card_enabled, product_card_anchor, price_sticker_enabled, background_mode, background_media_asset_id, background_options, null::text as scene_json, null::text as scene_sha256, null::timestamptz as frozen_at";

async function resolveRevision(client: PoolClient, runId: string, revisionId: string | undefined, writable: boolean) {
  if (revisionId && !UUID.test(revisionId)) return null;
  const current = await client.query<{ id: string; editable: boolean }>(
    `select sr.id, (r.state = 'DRAFT' and sr.approval_status = 'draft') as editable
     from live_runs r join show_revisions sr on sr.tenant_id = r.tenant_id and sr.id = r.show_revision_id
     where r.id = $1 and ($2::uuid is null or sr.id = $2)${writable ? " for update of r, sr" : ""}`,
    [runId, revisionId ?? null]
  );
  if (current.rows[0]) return current.rows[0];
  if (!revisionId) return null;
  const candidate = await client.query<{ id: string; editable: boolean }>(
    `select sr.id, (request.status = 'draft' and sr.approval_status = 'draft') as editable
     from show_program_change_requests request
     join live_runs r on r.tenant_id = request.tenant_id and r.id = request.live_run_id
     join show_revisions sr on sr.tenant_id = request.tenant_id and sr.id = request.candidate_revision_id
     where r.id = $1 and sr.id = $2${writable ? " for update of request, r, sr" : ""}`,
    [runId, revisionId]
  );
  return candidate.rows[0] ?? null;
}

function demoProgramRevision(runId: string) {
  const programs = (globalThis as typeof globalThis & { shuzhirenProgramStore?: { programs: Map<string, { tenantId: string; revisionId: string; editable: boolean }> } }).shuzhirenProgramStore?.programs;
  return programs?.get(runId) ?? null;
}

export async function getOverlayConfig(context: RequestContext, runId: string, revisionId?: string): Promise<OverlayConfig | null> {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) {
    if (context.accessScope === "restricted") throw new Response("Live run not found", { status: 404 });
    const program = demoProgramRevision(runId);
    const targetId = revisionId ?? program?.revisionId;
    if (!targetId) return null;
    const record = overlayStore().overlays.get(targetId);
    const revision = overlayStore().revisions.get(targetId);
    if (record && revision?.tenantId === context.tenantId && revision.runId === runId) return { ...record, backgroundOptions: { ...record.backgroundOptions } };
    return program?.tenantId === context.tenantId && targetId === program.revisionId ? { ...defaultOverlayConfig, backgroundOptions: {} } : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const revision = await resolveRevision(client, runId, revisionId, false);
    if (!revision) return null;
    const result = await client.query<OverlayRow>(`select ${OVERLAY_COLUMNS} from show_revision_overlays where show_revision_id = $1`, [revision.id]);
    const row = result.rows[0];
    return row ? overlayConfigFromRow(row) : null;
  }, { readOnly: true });
}

export async function replaceOverlayConfig(context: RequestContext, runId: string, input: unknown, revisionId?: string): Promise<OverlayConfig> {
  await assertLiveRunAccess(context, runId);
  const config = parseOverlayConfigInput(input);
  if (!config) throw new Response(overlayConfigProblem(input) ?? "画面层配置无效", { status: 400, statusText: "overlay_config_invalid" });
  if (!databasePool()) {
    if (context.accessScope === "restricted") throw new Response("Live run not found", { status: 404 });
    const program = demoProgramRevision(runId);
    const targetId = revisionId ?? program?.revisionId;
    if (!targetId) throw new Response("Live run not found", { status: 404 });
    const store = overlayStore();
    const revision = store.revisions.get(targetId);
    if (revisionId ? revision?.runId !== runId : program?.tenantId !== context.tenantId) throw new Response("Show revision not found", { status: 404 });
    if (!(revision?.editable ?? program?.editable)) throw new Response("Show overlay is locked after review submission", { status: 409, statusText: "overlay_not_editable" });
    store.revisions.set(targetId, { runId, tenantId: context.tenantId, editable: true });
    store.overlays.set(targetId, { ...config, backgroundOptions: { ...config.backgroundOptions }, sceneJson: null, sceneSha256: null, frozenAt: null });
    const configSha256 = createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");
    await recordAuditEvent(context, { type: "show_overlay.updated", resource: "show_revision", resourceId: targetId, detail: { runId, revisionId: targetId, configSha256, enabled: isEnabled(config) } });
    return config;
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const revision = await resolveRevision(client, runId, revisionId, true);
    if (!revision) throw new Response("Show revision not found", { status: 404 });
    if (!revision.editable) throw new Response("Show overlay is editable only on a DRAFT run or draft change request", { status: 409, statusText: "overlay_not_editable" });
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    await client.query(
      `insert into show_revision_overlays (tenant_id, show_revision_id, caption_enabled, caption_position, product_card_enabled, product_card_anchor, price_sticker_enabled, background_mode, background_media_asset_id, background_options, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       on conflict (tenant_id, show_revision_id) do update set caption_enabled = excluded.caption_enabled, caption_position = excluded.caption_position,
         product_card_enabled = excluded.product_card_enabled, product_card_anchor = excluded.product_card_anchor,
         price_sticker_enabled = excluded.price_sticker_enabled, background_mode = excluded.background_mode,
         background_media_asset_id = excluded.background_media_asset_id, background_options = excluded.background_options,
         updated_by = excluded.updated_by, updated_at = now()`,
      [context.tenantId, revision.id, config.captionEnabled, config.captionPosition, config.productCardEnabled, config.productCardAnchor, config.priceStickerEnabled, config.backgroundMode, config.backgroundMediaAssetId, JSON.stringify(config.backgroundOptions), actor.rows[0].id]
    );
    const configSha256 = createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");
    await recordAuditEventInTransaction(client, context, { type: "show_overlay.updated", resource: "show_revision", resourceId: revision.id, detail: { runId, revisionId: revision.id, configSha256, enabled: isEnabled(config) } });
    return config;
  });
}
