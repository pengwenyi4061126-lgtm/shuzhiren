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

test("overlay Gateway report fails closed and detects the frozen AIGC corner conflict", () => {
  const sceneJson = JSON.stringify({ version: 1 });
  const expected = { config: baseConfig, sceneJson, sceneSha256: digest(sceneJson), backgroundApproval: "approved", backgroundExpiresAt: "2026-11-30", priceValidUntil: "2026-11-30T16:00:00.000Z", now: new Date("2026-11-08T12:00:00.000Z") };
  const readiness = (position) => ({ status: "ok", dependencies: { livetalking: { overlay: { supported: true, aigc_position: position } } } });
  const missing = overlay.evaluateOverlayReport({ status: "ok", dependencies: { livetalking: {} } }, expected);
  assert.deepEqual(missing, { passed: false, detail: "运行时未报告画面层能力（LiveTalking 镜像可能缺少画面层补丁）" });
  assert.equal(overlay.evaluateOverlayReport({ status: "ok", dependencies: { livetalking: { overlay: { supported: false, aigc_position: "top-right" } } } }, expected).passed, false);
  assert.deepEqual(overlay.evaluateOverlayReport(readiness("bottom-right"), expected), { passed: false, detail: "画面层位置与 AIGC 角标位置冲突" });
  assert.deepEqual(overlay.evaluateOverlayReport(readiness("top-right"), expected), { passed: true, detail: "画面层已冻结（字幕、商品卡、背景）" });
});

test("run readiness permits a valid run with no overlay row on its existing database client", async () => {
  const previousMode = process.env.RUNTIME_GATEWAY_DEMO_MODE;
  process.env.RUNTIME_GATEWAY_DEMO_MODE = "true";
  try {
    const client = { query: async () => ({ rows: [{ run_revision_id: "revision-no-overlay", show_revision_id: null, background_mode: null, scene_json: null, scene_sha256: null, background_approval: null, background_expires_at: null, price_valid_until: null }] }) };
    assert.deepEqual(await overlay.evaluateOverlayReadinessForRun(client, "run-no-overlay"), { passed: true, detail: "未启用画面层" });
  } finally { if (previousMode === undefined) delete process.env.RUNTIME_GATEWAY_DEMO_MODE; else process.env.RUNTIME_GATEWAY_DEMO_MODE = previousMode; }
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

const { cloneDemoProgramRevision, registerDemoProgram, updateDemoProgramLifecycle } = await import("../apps/console/lib/show-program.ts");
const { listAssets } = await import("../apps/console/lib/assets.ts");
const demoContext = { tenantId: "tenant_demo", actorId: "overlay-reviewer", actorName: "Overlay Reviewer", role: "operator", accessScope: "tenant" };
let demoCounter = 0;
function demoProgram(overlayConfig) {
  demoCounter += 1;
  const runId = `run_overlay_demo_${demoCounter}`;
  const revisionId = `show_revision_overlay_demo_${demoCounter}`;
  const program = {
    runId,
    tenantId: demoContext.tenantId,
    revisionId,
    status: "draft",
    editable: true,
    overlayConfig,
    segments: [
      { id: `segment_overlay_${demoCounter}`, position: 1, kind: "prepared_product", title: "商品讲解", durationSeconds: 90, productVersionId: "pv_a102_v1", purpose: "已审核商品讲解", runtimeScript: "介绍已审核商品信息。", fallback: false },
      { id: `fallback_overlay_${demoCounter}`, position: 2, kind: "fallback", title: "备用", durationSeconds: 30, productVersionId: "pv_a102_v1", purpose: "故障降级", fallback: true },
      { id: `handoff_overlay_${demoCounter}`, position: 3, kind: "human_handoff", title: "转人工", durationSeconds: 0, purpose: "人工接管", fallback: true }
    ]
  };
  registerDemoProgram(program);
  return program;
}

test("demo run preflight blocks unfrozen or damaged scenes, expired prices, and revoked backgrounds", async () => {
  const previousMode = process.env.RUNTIME_GATEWAY_DEMO_MODE;
  process.env.RUNTIME_GATEWAY_DEMO_MODE = "true";
  const plain = { ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} };
  async function freeze(config) { const program = demoProgram(config); await updateDemoProgramLifecycle(program.runId, "submit_review", demoContext); await updateDemoProgramLifecycle(program.runId, "approve", demoContext); return program; }
  try {
    const pending = demoProgram(plain);
    assert.deepEqual(await overlay.evaluateOverlayReadinessForRun(null, pending.runId), { passed: false, detail: "画面层配置未冻结或已损坏" });
    const damaged = await freeze(plain);
    globalThis.shuzhirenOverlayStore.overlays.get(damaged.revisionId).sceneSha256 = "f".repeat(64);
    assert.deepEqual(await overlay.evaluateOverlayReadinessForRun(null, damaged.runId), { passed: false, detail: "画面层配置未冻结或已损坏" });
    const expired = await freeze(plain);
    const version = [...globalThis.shuzhirenCatalog.products.values()].flatMap((p) => p.versions).find((v) => v.id === "pv_a102_v1");
    const previousValidUntil = version.facts.validUntil;
    version.facts.validUntil = "2026-11-06T23:59:59.000Z";
    try { assert.deepEqual(await overlay.evaluateOverlayReadinessForRun(null, expired.runId), { passed: false, detail: "商品价格有效期已过，请发起节目变更" }); }
    finally { version.facts.validUntil = previousValidUntil; }
    await listAssets(demoContext);
    const assetId = `overlay_readiness_asset_${demoCounter}`;
    globalThis.shuzhirenAssetStore.assets.set(assetId, { id: assetId, tenantId: demoContext.tenantId, kind: "overlay_background", name: "测试背景", approval: "approved", expiresAt: "2026-11-30", rightsScope: "场景测试", source: "场景测试", objectKey: `demo/${assetId}.png`, checksum: `sha256:${"b".repeat(64)}` });
    const background = await freeze({ ...baseConfig, backgroundMediaAssetId: assetId });
    globalThis.shuzhirenAssetStore.assets.get(assetId).approval = "revoked";
    assert.deepEqual(await overlay.evaluateOverlayReadinessForRun(null, background.runId), { passed: false, detail: "背景素材授权无效" });
    globalThis.shuzhirenAssetStore.assets.delete(assetId);
  } finally { if (previousMode === undefined) delete process.env.RUNTIME_GATEWAY_DEMO_MODE; else process.env.RUNTIME_GATEWAY_DEMO_MODE = previousMode; }
});

test("demo approval freezes configured overlay and its summary hash, and a cloned revision clears frozen fields", async () => {
  const program = demoProgram({ ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} });
  await updateDemoProgramLifecycle(program.runId, "submit_review", demoContext);
  const sceneSha256 = await updateDemoProgramLifecycle(program.runId, "approve", demoContext);
  const frozen = globalThis.shuzhirenOverlayStore.overlays.get(program.revisionId);
  assert.equal(program.status, "approved");
  assert.equal(frozen.sceneSha256, sceneSha256);
  assert.equal(frozen.sceneSha256, digest(frozen.sceneJson));
  assert.equal(globalThis.shuzhirenOverlayStore.revisions.get(program.revisionId).editable, false);
  assert.equal((await updateDemoProgramLifecycle(program.runId, "approve", demoContext)), sceneSha256);
  const cloned = cloneDemoProgramRevision(program, `${program.revisionId}_candidate`);
  assert.deepEqual(cloned.overlayConfig, { ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} });
  assert.equal(cloned.overlaySceneSha256, null);
  assert.deepEqual(
    (({ sceneJson, sceneSha256: hash, frozenAt }) => ({ sceneJson, sceneSha256: hash, frozenAt }))(globalThis.shuzhirenOverlayStore.overlays.get(`${program.revisionId}_candidate`)),
    { sceneJson: null, sceneSha256: null, frozenAt: null }
  );
});

test("demo approval fails closed on unapproved background and blocked product title without approving", async () => {
  const pendingBackground = { ...baseConfig, backgroundMode: "canvas", backgroundMediaAssetId: "asset_overlay_pending", backgroundOptions: { avatarAnchor: "left", avatarScalePermille: 800 } };
  const blockedBackground = demoProgram(pendingBackground);
  await listAssets(demoContext);
  globalThis.shuzhirenAssetStore.assets.set("asset_overlay_pending", { id: "asset_overlay_pending", tenantId: demoContext.tenantId, kind: "overlay_background", name: "Pending background", approval: "pending", checksum: asset.checksum });
  await updateDemoProgramLifecycle(blockedBackground.runId, "submit_review", demoContext);
  await assert.rejects(updateDemoProgramLifecycle(blockedBackground.runId, "approve", demoContext), (error) => error instanceof Response && error.status === 422 && error.statusText === "overlay_scene_unavailable");
  assert.equal(blockedBackground.status, "draft");

  const blockedText = demoProgram({ ...baseConfig, productCardEnabled: true, priceStickerEnabled: true, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} });
  const productRecord = globalThis.shuzhirenCatalog.products.get("product_a102");
  const originalName = productRecord.name;
  productRecord.name = "全网最低洁面慕斯";
  try {
    await updateDemoProgramLifecycle(blockedText.runId, "submit_review", demoContext);
    await assert.rejects(updateDemoProgramLifecycle(blockedText.runId, "approve", demoContext), (error) => error instanceof Response && error.status === 422 && error.statusText === "overlay_text_policy_blocked");
    assert.equal(blockedText.status, "draft");
  } finally {
    productRecord.name = originalName;
  }
});

test("overlay routes keep the read and edit role matrix, validate input, and return config without frozen scene fields", async () => {
  const programRunId = "50000000-0000-4000-8000-000000000001";
  const revisionRunId = "50000000-0000-4000-8000-000000000002";
  registerDemoProgram({
    runId: programRunId,
    tenantId: demoContext.tenantId,
    revisionId: "50000000-0000-4000-8000-000000000011",
    status: "draft",
    editable: true,
    overlayConfig: { ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} },
    segments: []
  });
  registerDemoProgram({ runId: revisionRunId, tenantId: demoContext.tenantId, revisionId: "50000000-0000-4000-8000-000000000012", status: "draft", editable: true, segments: [] });
  const { GET: getProgramOverlay, PUT: putProgramOverlay } = await import("../apps/console/app/api/v1/live-runs/[runId]/program/overlay/route.ts");
  const { GET: getRevisionOverlay, PUT: putRevisionOverlay } = await import("../apps/console/app/api/v1/live-runs/[runId]/program-revisions/[requestId]/overlay/route.ts");
  const { POST: createAsset } = await import("../apps/console/app/api/v1/assets/route.ts");
  const saved = { identity: process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY, hostname: process.env.HOSTNAME, demo: process.env.CONTROL_PLANE_DEMO_MODE };
  process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";
  process.env.HOSTNAME = "127.0.0.1";
  process.env.CONTROL_PLANE_DEMO_MODE = "true";
  const request = (role, runId, method = "GET", body) => new Request(`http://console.test/api/v1/live-runs/${runId}/program/overlay`, {
    method,
    headers: { "x-tenant-id": demoContext.tenantId, "x-actor-id": `overlay-${role}`, "x-actor-name": "Overlay Test", "x-actor-role": role, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  try {
    for (const role of ["admin", "operator", "reviewer", "analyst"]) {
      const response = await getProgramOverlay(request(role, programRunId), { params: Promise.resolve({ runId: programRunId }) });
      assert.equal(response.status, 200, `${role} can read the program overlay`);
      const body = await response.json();
      assert.ok(body.data);
      assert.equal("scene_json" in body.data, false);
    }
    for (const role of ["admin", "operator"]) {
      const response = await putProgramOverlay(request(role, programRunId, "PUT", baseConfig), { params: Promise.resolve({ runId: programRunId }) });
      assert.equal(response.status, 200, `${role} can edit the draft program overlay`);
    }
    for (const role of ["reviewer", "analyst"]) {
      const response = await putProgramOverlay(request(role, programRunId, "PUT", baseConfig), { params: Promise.resolve({ runId: programRunId }) });
      assert.equal(response.status, 403, `${role} cannot edit the program overlay`);
    }
    const invalid = await putProgramOverlay(request("admin", programRunId, "PUT", { ...baseConfig, backgroundMode: "invalid" }), { params: Promise.resolve({ runId: programRunId }) });
    assert.equal(invalid.status, 400);
    await assert.rejects(overlay.getOverlayConfig({ ...demoContext, accessScope: "restricted", membershipId: "membership-restricted" }, programRunId), (error) => error instanceof Response && error.status === 404);
    await assert.rejects(overlay.replaceOverlayConfig({ ...demoContext, accessScope: "restricted", membershipId: "membership-restricted" }, programRunId, baseConfig), (error) => error instanceof Response && error.status === 404);

    for (const role of ["admin", "operator", "reviewer", "analyst"]) {
      const response = await getRevisionOverlay(request(role, revisionRunId), { params: Promise.resolve({ runId: revisionRunId, requestId: "missing-request" }) });
      assert.equal(response.status, 404, `${role} is allowed to read but no demo change request exists`);
    }
    for (const role of ["admin", "operator"]) {
      const response = await putRevisionOverlay(request(role, revisionRunId, "PUT", baseConfig), { params: Promise.resolve({ runId: revisionRunId, requestId: "missing-request" }) });
      assert.equal(response.status, 404, `${role} reaches the revision service but the request is absent`);
    }
    for (const role of ["reviewer", "analyst"]) {
      const response = await putRevisionOverlay(request(role, revisionRunId, "PUT", baseConfig), { params: Promise.resolve({ runId: revisionRunId, requestId: "missing-request" }) });
      assert.equal(response.status, 403, `${role} cannot edit revision overlays`);
    }
    const assetResponse = await createAsset(new Request("http://console.test/api/v1/assets", {
      method: "POST",
      headers: { "x-tenant-id": demoContext.tenantId, "x-actor-id": "overlay-operator", "x-actor-name": "Overlay Test", "x-actor-role": "operator", "content-type": "application/json" },
      body: JSON.stringify({ kind: "overlay_background", name: "背景图片", rightsScope: "直播背景展示", source: "素材授权证明", objectKey: "tenant/backgrounds/scene.png", checksum: `sha256:${"e".repeat(64)}` })
    }));
    assert.equal(assetResponse.status, 201);
    assert.equal((await assetResponse.json()).data.contentVerification.contentType, "image/png");
  } finally {
    for (const [key, value] of [["CONTROL_PLANE_DEV_HEADER_IDENTITY", saved.identity], ["HOSTNAME", saved.hostname], ["CONTROL_PLANE_DEMO_MODE", saved.demo]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("overlay background media verification accepts only PNG/JPEG and does not become a required live asset", async () => {
  const assets = await import("../apps/console/lib/assets.ts");
  const { verifyMediaAssetContent } = await import("../apps/console/lib/media-evidence.ts");
  assert.deepEqual(assets.requiredLiveAssetKinds, ["portrait", "voice", "product_clip", "music"]);
  const saved = {
    databaseUrl: process.env.DATABASE_URL,
    demo: process.env.CONTROL_PLANE_DEMO_MODE,
    verifierUrl: process.env.MEDIA_EVIDENCE_VERIFIER_URL,
    verifierToken: process.env.MEDIA_EVIDENCE_VERIFIER_TOKEN,
    fetch: globalThis.fetch
  };
  process.env.DATABASE_URL = "postgres://integration.invalid/control_plane";
  process.env.CONTROL_PLANE_DEMO_MODE = "false";
  process.env.MEDIA_EVIDENCE_VERIFIER_URL = "http://127.0.0.1:8080";
  process.env.MEDIA_EVIDENCE_VERIFIER_TOKEN = "x".repeat(48);
  let responseContentType = "image/png";
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body);
    return Response.json({ objectKey: input.objectKey, checksum: input.expectedChecksum, objectVersion: "overlay-v1", bytes: 128, contentType: responseContentType, evidenceRef: "evidence://overlay/test", verifiedAt: new Date().toISOString() });
  };
  try {
    for (const contentType of ["image/png", "image/jpeg"]) {
      responseContentType = contentType;
      const result = await verifyMediaAssetContent(demoContext, { kind: "overlay_background", objectKey: "tenant/backgrounds/scene.png", checksum: `sha256:${"c".repeat(64)}` });
      assert.equal(result.contentType, contentType);
    }
    for (const contentType of ["video/mp4", "audio/wav"]) {
      responseContentType = contentType;
      await assert.rejects(verifyMediaAssetContent(demoContext, { kind: "overlay_background", objectKey: "tenant/backgrounds/scene.png", checksum: `sha256:${"c".repeat(64)}` }), (error) => error instanceof Response && error.status === 502);
    }
  } finally {
    for (const [key, value] of [["DATABASE_URL", saved.databaseUrl], ["CONTROL_PLANE_DEMO_MODE", saved.demo], ["MEDIA_EVIDENCE_VERIFIER_URL", saved.verifierUrl], ["MEDIA_EVIDENCE_VERIFIER_TOKEN", saved.verifierToken]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = saved.fetch;
  }
  const demoVerification = await verifyMediaAssetContent(demoContext, { kind: "overlay_background", objectKey: "tenant/backgrounds/demo.png", checksum: `sha256:${"d".repeat(64)}` });
  assert.equal(demoVerification.contentType, "image/png");
});
