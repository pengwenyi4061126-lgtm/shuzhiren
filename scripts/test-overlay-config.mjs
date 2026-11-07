import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("./lib/console-ts-loader.mjs", import.meta.url);
const overlay = await import("../apps/console/lib/overlay-scene.ts");
const { canonicalJson } = await import("../apps/console/lib/canonical-json.mjs");

const baseConfig = {
  captionEnabled: true,
  captionPosition: "bottom_band",
  productCardEnabled: true,
  productCardAnchor: "middle-right",
  priceStickerEnabled: true,
  backgroundMode: "canvas",
  backgroundMediaAssetId: "asset-background",
  backgroundOptions: { avatarAnchor: "left", avatarScalePermille: 800 }
};
const product = { id: "pv-1", revision: 3, name: "洁面慕斯 120ml", priceCent: 9900, validUntil: "2026-11-30T16:00:00.000Z" };
const asset = { id: "asset-background", checksum: `sha256:${"a".repeat(64)}` };
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("console config enums and text limits match the LiveTalking scene parser", async () => {
  const runtime = await readFile(new URL("../runtime/livetalking/shuzhiren_overlay.py", import.meta.url), "utf8");
  const label = await readFile(new URL("../runtime/livetalking/shuzhiren_aigc_label.py", import.meta.url), "utf8");
  const tuple = (source, name) => {
    const match = new RegExp(`^${name} = \\(([^)]*)\\)$`, "m").exec(source);
    assert.ok(match, `${name} exists in the LiveTalking runtime`);
    return Array.from(match[1].matchAll(/"([^\"]+)"/g), (item) => item[1]);
  };
  assert.deepEqual([...overlay.OVERLAY_CAPTION_POSITIONS], tuple(runtime, "CAPTION_POSITIONS"));
  assert.deepEqual([...overlay.OVERLAY_PRODUCT_CARD_ANCHORS], tuple(runtime, "CARD_ANCHORS"));
  assert.deepEqual([...overlay.OVERLAY_BACKGROUND_MODES], tuple(runtime, "BACKGROUND_MODES"));
  assert.deepEqual([...overlay.OVERLAY_AVATAR_ANCHORS], tuple(runtime, "AVATAR_ANCHORS"));
  assert.deepEqual([...overlay.AIGC_LABEL_POSITIONS], tuple(label, "POSITIONS"));
  assert.match(runtime, /MAX_TITLE_CHARS = 60/);
  assert.match(runtime, /MAX_PRICE_TEXT_CHARS = 16/);
  assert.match(runtime, /MAX_NOTE_CHARS = 40/);
  assert.match(runtime, /MIN_AVATAR_SCALE_PERMILLE = 500/);
  assert.match(runtime, /MAX_AVATAR_SCALE_PERMILLE = 1000/);
  assert.match(runtime, /MAX_TOLERANCE = 255/);
});

test("overlay config parser validates enums, dependencies, and background option ranges", () => {
  assert.deepEqual(overlay.parseOverlayConfigInput(baseConfig), baseConfig);
  assert.equal(overlay.overlayConfigProblem({ ...baseConfig, priceStickerEnabled: true, productCardEnabled: false }), "启用价格贴片时必须启用商品卡");
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, captionPosition: "middle" }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, productCardAnchor: "center" }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundOptions: { avatarAnchor: "up", avatarScalePermille: 800 } }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundOptions: { avatarAnchor: "left", avatarScalePermille: 1001 } }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundMode: "chroma_key", backgroundOptions: { keyColor: "00ff00", tolerance: 0 } }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundMode: "chroma_key", backgroundOptions: { keyColor: "#00ff00", tolerance: 256 } }), null);
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} }).backgroundMode, "none");
  assert.equal(overlay.parseOverlayConfigInput({ ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: "asset-background" }), null);
});

test("scene building is stable, canonical, and hashes exactly the UTF-8 scene JSON", () => {
  const sceneA = overlay.buildOverlayScene("revision-1", baseConfig, product, asset);
  const sceneB = overlay.buildOverlayScene("revision-1", { ...baseConfig }, { ...product }, { ...asset });
  const jsonA = canonicalJson(sceneA);
  const jsonB = canonicalJson(sceneB);
  assert.equal(jsonA, jsonB);
  assert.equal(digest(jsonA), digest(jsonB));
  assert.deepEqual(JSON.parse(jsonA), {
    background: { assetSha256: "a".repeat(64), avatarAnchor: "left", avatarScalePermille: 800, mode: "canvas" },
    caption: { enabled: true, position: "bottom_band" },
    priceSticker: { note: "价格以下单页为准", priceText: "¥99.00", validUntil: product.validUntil },
    product: { productVersionId: "pv-1", revision: 3 },
    productCard: { anchor: "middle-right", title: product.name },
    revisionId: "revision-1",
    version: 1
  });
  assert.deepEqual(overlay.buildOverlayScene("revision-2", { ...baseConfig, productCardEnabled: false, priceStickerEnabled: false, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} }, null, null).background, { mode: "none" });
});

test("AIGC conflict matrix follows the runtime's four corners and caption bands", () => {
  for (const position of overlay.AIGC_LABEL_POSITIONS) {
    for (const anchor of overlay.OVERLAY_PRODUCT_CARD_ANCHORS) {
      const config = { ...baseConfig, captionEnabled: false, priceStickerEnabled: false, productCardAnchor: anchor };
      assert.equal(overlay.overlayAigcConflicts(config, position), anchor === position, `${anchor} against ${position}`);
    }
    for (const captionPosition of overlay.OVERLAY_CAPTION_POSITIONS) {
      const config = { ...baseConfig, productCardEnabled: false, priceStickerEnabled: false, captionEnabled: true, captionPosition };
      assert.equal(overlay.overlayAigcConflicts(config, position), captionPosition.startsWith(position.split("-")[0]), `${captionPosition} against ${position}`);
    }
  }
  assert.equal(overlay.overlayAigcConflicts({ ...baseConfig, productCardEnabled: false, priceStickerEnabled: false, captionEnabled: false }, "invalid"), false);
});

test("overlay readiness returns the eight F.4 outcomes and exact details", () => {
  const sceneJson = JSON.stringify({ version: 1 });
  const sceneSha256 = digest(sceneJson);
  const now = new Date("2026-11-08T12:00:00.000Z");
  const valid = { config: baseConfig, sceneJson, sceneSha256, backgroundApproval: "approved", backgroundExpiresAt: "2026-11-30", priceValidUntil: "2026-11-30T16:00:00.000Z", gatewayOverlay: { supported: true, aigcPosition: "top-right" }, now };
  const outcomes = [
    [overlay.evaluateOverlayReadiness({ ...valid, config: null, sceneJson: null, sceneSha256: null }), true, "未启用画面层"],
    [overlay.evaluateOverlayReadiness({ ...valid, config: null, overlayPresent: true, sceneJson: null, sceneSha256: null }), false, "画面层配置未冻结或已损坏"],
    [overlay.evaluateOverlayReadiness({ ...valid, sceneSha256: null }), false, "画面层配置未冻结或已损坏"],
    [overlay.evaluateOverlayReadiness({ ...valid, backgroundApproval: "revoked" }), false, "背景素材授权无效"],
    [overlay.evaluateOverlayReadiness({ ...valid, priceValidUntil: "2026-11-07T23:59:59.000Z" }), false, "商品价格有效期已过，请发起节目变更"],
    [overlay.evaluateOverlayReadiness({ ...valid, demoGateway: true }), true, "演示网关：未连接 LiveTalking，画面层未经运行时核验"],
    [overlay.evaluateOverlayReadiness({ ...valid, gatewayOverlay: null }), false, "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）"],
    [overlay.evaluateOverlayReadiness({ ...valid, gatewayOverlay: { supported: true, aigcPosition: "invalid" } }), false, "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）"],
    [overlay.evaluateOverlayReadiness({ ...valid, gatewayOverlay: { supported: true, aigcPosition: "bottom-right" } }), false, "画面层位置与 AIGC 角标位置冲突"],
    [overlay.evaluateOverlayReadiness(valid), true, "画面层已冻结（字幕、商品卡、背景）"]
  ];
  for (const [actual, passed, detail] of outcomes) assert.deepEqual(actual, { passed, detail });
  assert.deepEqual(overlay.evaluateOverlayReadiness({ ...valid, sceneJson: `${sceneJson} ` }), { passed: false, detail: "画面层配置未冻结或已损坏" });
});

function overlayRow(config = baseConfig) {
  return {
    tenant_id: "tenant-1",
    show_revision_id: "revision-1",
    caption_enabled: config.captionEnabled,
    caption_position: config.captionPosition,
    product_card_enabled: config.productCardEnabled,
    product_card_anchor: config.productCardAnchor,
    price_sticker_enabled: config.priceStickerEnabled,
    background_mode: config.backgroundMode,
    background_media_asset_id: config.backgroundMediaAssetId,
    background_options: config.backgroundOptions,
    scene_json: null,
    scene_sha256: null,
    frozen_at: null
  };
}

function freezeClient({ row = overlayRow(), productRow = { id: product.id, revision: product.revision, name: product.name, approval_status: "approved", facts: { priceCent: product.priceCent, validUntil: product.validUntil } }, assetRow = { id: asset.id, kind: "overlay_background", approval_status: "approved", expires_at: "2026-11-30", checksum: asset.checksum }, beforeFreeze } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("from show_revision_overlays")) return { rows: [row] };
      if (sql.includes("from show_revision_product_versions")) return { rows: productRow ? [productRow] : [] };
      if (sql.includes("from media_assets")) return { rows: assetRow ? [assetRow] : [] };
      if (sql.includes("show_revision_policy_profiles")) return { rows: [] };
      if (sql.includes("from tenant_prohibited_terms")) return { rows: [] };
      if (sql.startsWith("update show_revision_overlays")) {
        beforeFreeze?.(params[1]);
        return { rows: [{ frozen_at: "2026-11-08T12:00:00.000Z" }] };
      }
      throw new Error(`Unexpected freeze query: ${sql}`);
    }
  };
}

test("transactional freeze uses approved frozen inputs and writes canonical JSON plus SHA-256", async () => {
  const client = freezeClient();
  const frozen = await overlay.freezeOverlaySceneInTransaction(client, "revision-1");
  assert.equal(frozen.sceneSha256, digest(frozen.sceneJson));
  assert.equal(JSON.parse(frozen.sceneJson).productCard.title, product.name);
  assert.equal(JSON.parse(frozen.sceneJson).priceSticker.priceText, "¥99.00");
  assert.equal(JSON.parse(frozen.sceneJson).background.assetSha256, "a".repeat(64));
  assert.equal(client.calls.at(-1).sql.startsWith("update show_revision_overlays"), true);
});

test("transactional freeze rejects blocked text and unavailable, wrong-kind, or expired background assets", async () => {
  const blocked = freezeClient({ productRow: { id: product.id, revision: 3, name: "全网最低洁面", approval_status: "approved", facts: { priceCent: 9900 } } });
  await assert.rejects(overlay.freezeOverlaySceneInTransaction(blocked, "revision-1"), (error) => error instanceof Response && error.status === 422 && error.statusText === "overlay_text_policy_blocked");
  for (const assetRow of [
    { id: asset.id, kind: "overlay_background", approval_status: "pending", expires_at: null, checksum: asset.checksum },
    { id: asset.id, kind: "portrait", approval_status: "approved", expires_at: null, checksum: asset.checksum },
    { id: asset.id, kind: "overlay_background", approval_status: "approved", expires_at: "2026-11-06", checksum: asset.checksum }
  ]) {
    const client = freezeClient({ assetRow });
    await assert.rejects(overlay.freezeOverlaySceneInTransaction(client, "revision-1"), (error) => error instanceof Response && error.status === 422 && error.statusText === "overlay_scene_unavailable");
  }
});

test("freezing disabled or absent overlay configuration writes no scene", async () => {
  const disabled = freezeClient({ row: overlayRow({ ...baseConfig, captionEnabled: false, productCardEnabled: false, priceStickerEnabled: false, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} }) });
  assert.equal(await overlay.freezeOverlaySceneInTransaction(disabled, "revision-1"), null);
  const absent = freezeClient({ row: null });
  assert.equal(await overlay.freezeOverlaySceneInTransaction(absent, "revision-1"), null);
});
