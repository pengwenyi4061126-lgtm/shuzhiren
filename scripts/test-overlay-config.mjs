import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("./lib/console-ts-loader.mjs", import.meta.url);
const overlay = await import("../apps/console/lib/overlay-scene.ts");
const { canonicalJson } = await import("../apps/console/lib/canonical-json.mjs");
const { createMediaCommand } = await import("../apps/console/lib/media-protocol.ts");
const runtimeGateway = await import("../apps/console/lib/runtime-gateway.ts");

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

test("Gateway receives frozen overlay fields and receipts must bind the matching scene hash", async () => {
  const saved = { url: process.env.RUNTIME_GATEWAY_URL, token: process.env.RUNTIME_SHARED_TOKEN, demo: process.env.RUNTIME_GATEWAY_DEMO_MODE, fetch: globalThis.fetch };
  process.env.RUNTIME_GATEWAY_URL = "http://gateway.test"; process.env.RUNTIME_SHARED_TOKEN = "x".repeat(48); process.env.RUNTIME_GATEWAY_DEMO_MODE = "false";
  const sceneJson = canonicalJson({ version: 1 }); const sceneSha256 = digest(sceneJson); let received;
  const command = createMediaCommand({ runId: "00000000-0000-4000-8000-000000000099", traceId: "trace-overlay", type: "start_program", payload: { controlAction: "START", overlaySceneJson: sceneJson, overlaySceneSha256: sceneSha256 } });
  assert.throws(() => createMediaCommand({ runId: command.runId, traceId: command.traceId, type: "start_program", payload: { controlAction: "START", overlaySceneJson: sceneJson } }), /provided together/);
  globalThis.fetch = async (_url, options) => {
    received = JSON.parse(options.body);
    return Response.json({ accepted: true, command_id: command.id, session_id: "session-overlay", action: command.type, receipt: { command_id: command.id, session_id: "session-overlay", action: command.type, accepted_at: new Date().toISOString(), overlay_scene_sha256: received.receiptHash } });
  };
  try {
    for (const receiptHash of [undefined, "0".repeat(64)]) {
      received = undefined;
      globalThis.fetch = async (_url, options) => { received = JSON.parse(options.body); return Response.json({ accepted: true, receipt: { command_id: command.id, session_id: "session-overlay", action: command.type, accepted_at: new Date().toISOString(), ...(receiptHash ? { overlay_scene_sha256: receiptHash } : {}) } }); };
      await assert.rejects(runtimeGateway.dispatchMediaCommand(command, "session-overlay"), /receipt does not bind the media command/);
      assert.equal(received.overlay_scene_json, sceneJson);
      assert.equal(received.overlay_scene_sha256, sceneSha256);
    }
    globalThis.fetch = async (_url, options) => { received = JSON.parse(options.body); return Response.json({ accepted: true, receipt: { command_id: command.id, session_id: "session-overlay", action: command.type, accepted_at: new Date().toISOString(), overlay_scene_sha256: sceneSha256 } }); };
    assert.equal((await runtimeGateway.dispatchMediaCommand(command, "session-overlay")).delivery, "accepted");
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [["RUNTIME_GATEWAY_URL", saved.url], ["RUNTIME_SHARED_TOKEN", saved.token], ["RUNTIME_GATEWAY_DEMO_MODE", saved.demo]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
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
const { issueCommand, mediaCommandFor } = await import("../apps/console/lib/control-plane/store.ts");
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

test("START and RECOVER dispatch only verified frozen scenes and never bind overlays to program transitions", async () => {
  const run = { id: "run_overlay_dispatch_unit", tenantId: demoContext.tenantId, revisionId: "revision_overlay_dispatch_unit", traceId: "trace_overlay_dispatch_unit", state: "LIVE", channelConnectionId: "channel_demo", productVersionId: "pv_a102_v1", hasOperator: true, hasApprovedRights: true, hasApprovedSkuVersion: true, hasFallbackProgram: true, channelReady: true, outputReady: true, aiDisclosureEnabled: true, runtimeSessionId: "session_overlay_dispatch_unit", commandHistory: [], questions: [] };
  const sceneJson = canonicalJson({ version: 1 }); const sceneSha256 = digest(sceneJson);
  for (const action of ["START", "RECOVER"]) {
    const command = mediaCommandFor(run, action, undefined, undefined, undefined, undefined, { sceneJson, sceneSha256 });
    assert.deepEqual({ scene: command.payload.overlaySceneJson, hash: command.payload.overlaySceneSha256 }, { scene: sceneJson, hash: sceneSha256 });
  }
  for (const action of ["INSERT_PROGRAM", "ROLLBACK_PROGRAM"]) {
    const command = mediaCommandFor(run, action, { kind: action === "INSERT_PROGRAM" ? "insert" : "rollback" });
    assert.equal(command.payload.overlaySceneJson, undefined);
    assert.equal(command.payload.overlaySceneSha256, undefined);
  }
  assert.deepEqual(mediaCommandFor(run, "START").payload, { controlAction: "START" }, "a run with no overlay keeps its legacy payload unchanged");

  const controls = globalThis.shuzhirenControlStore ??= { runs: new Map(), idempotency: new Map() };
  const telemetry = globalThis.shuzhirenMonitoringStore ??= { telemetry: new Map(), alerts: new Map() };
  const outbox = globalThis.shuzhirenOutboxStore ??= { events: new Map(), speechCommandEvents: new Map() };
  const program = demoProgram({ ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} });
  const generatedRunId = program.runId; program.runId = crypto.randomUUID(); globalThis.shuzhirenProgramStore.programs.delete(generatedRunId); registerDemoProgram(program);
  const demoRun = { ...run, id: program.runId, revisionId: program.revisionId, state: "DEGRADED", traceId: program.runId, runtimeSessionId: `${program.runId}_session`, activeProgramSegmentId: program.segments[0].id };
  controls.runs.set(demoRun.id, demoRun);
  telemetry.telemetry.set(demoRun.id, { runId: demoRun.id, tenantId: demoContext.tenantId, sampledAt: new Date().toISOString(), outputConnected: true, inferenceFps: 30, outputFps: 30, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 50, gpuMemoryMiB: 8000, audioActive: true, fallbackReady: true });
  await updateDemoProgramLifecycle(program.runId, "submit_review", demoContext);
  await updateDemoProgramLifecycle(program.runId, "approve", demoContext);
  const frozen = globalThis.shuzhirenOverlayStore.overlays.get(program.revisionId);
  const before = [...outbox.events.values()].filter((event) => event.type === "media.dispatch" && event.command.runId === demoRun.id).length;
  try {
    await issueCommand(demoContext, demoRun.id, { action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: `${demoRun.id}_recover_valid` });
  } catch (error) { throw error; }
  const dispatched = [...outbox.events.values()].find((event) => event.type === "media.dispatch" && event.command.runId === demoRun.id);
  assert.equal(dispatched.command.payload.overlaySceneJson, frozen.sceneJson);
  assert.equal(dispatched.command.payload.overlaySceneSha256, digest(frozen.sceneJson));
  assert.equal(dispatched.command.type, "start_program");
  assert.equal([...outbox.events.values()].filter((event) => event.type === "media.dispatch" && event.command.runId === demoRun.id).length, before + 1);

  const corrupt = demoProgram({ ...baseConfig, backgroundMode: "none", backgroundMediaAssetId: null, backgroundOptions: {} });
  const oldId = corrupt.runId; corrupt.runId = crypto.randomUUID(); globalThis.shuzhirenProgramStore.programs.delete(oldId); registerDemoProgram(corrupt);
  const corruptRun = { ...demoRun, id: corrupt.runId, revisionId: corrupt.revisionId, traceId: corrupt.runId, state: "DEGRADED", commandHistory: [] };
  controls.runs.set(corruptRun.id, corruptRun);
  telemetry.telemetry.set(corruptRun.id, { runId: corruptRun.id, tenantId: demoContext.tenantId, sampledAt: new Date().toISOString(), outputConnected: true, inferenceFps: 30, outputFps: 30, avSyncMs: 20, bitrateMbps: 4, gpuUtilization: 50, gpuMemoryMiB: 8000, audioActive: true, fallbackReady: true });
  await updateDemoProgramLifecycle(corrupt.runId, "submit_review", demoContext); await updateDemoProgramLifecycle(corrupt.runId, "approve", demoContext);
  globalThis.shuzhirenOverlayStore.overlays.get(corrupt.revisionId).sceneSha256 = "0".repeat(64);
  const corruptCount = [...outbox.events.values()].filter((event) => event.type === "media.dispatch" && event.command.runId === corruptRun.id).length;
  await assert.rejects(issueCommand(demoContext, corruptRun.id, { action: "RECOVER", expectedState: "DEGRADED", idempotencyKey: `${corruptRun.id}_recover_corrupt` }), (error) => error instanceof Response && error.status === 409 && error.statusText === "overlay_scene_hash_invalid");
  assert.equal(corruptRun.commandHistory.length, 0);
  assert.equal([...outbox.events.values()].filter((event) => event.type === "media.dispatch" && event.command.runId === corruptRun.id).length, corruptCount, "hash failure must not queue a media dispatch");
});

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
    const overlayAudit = globalThis.shuzhirenAuditStore.events.filter((event) => event.type === "show_overlay.updated" && event.resourceId === "50000000-0000-4000-8000-000000000011");
    assert.equal(overlayAudit.length, 2);
    for (const event of overlayAudit) {
      assert.deepEqual(Object.keys(event.detail).sort(), ["configSha256", "enabled", "revisionId", "runId"]);
      assert.match(event.detail.configSha256, /^[0-9a-f]{64}$/);
      assert.equal(event.detail.runId, programRunId);
      assert.equal(event.detail.revisionId, "50000000-0000-4000-8000-000000000011");
      assert.equal(JSON.stringify(event.detail).includes("sceneJson"), false);
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

test("worker scheduled starts dispatch only hash-verified frozen overlays and bind Gateway receipts", async () => {
  const workerSource = (await readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const workerPolicy = await import("../apps/console/lib/shared/policy-engine.mjs");
  const workerGuard = await import("../apps/console/lib/shared/broadcast-guard.mjs");
  const workerBuiltin = await import("../apps/console/lib/shared/prohibited-terms-builtin.mjs");
  const workerTerms = await import("../apps/console/lib/shared/prohibited-terms.mjs");
  const workerRotation = await import("../apps/console/lib/shared/script-rotation.mjs");
  const slice = (startMarker, endMarker) => {
    const start = workerSource.indexOf(startMarker);
    const end = workerSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `worker source contains ${startMarker} before ${endMarker}`);
    return workerSource.slice(start, end);
  };
  const scheduleSource = [
    slice("function tenantOrder(", "function inTenantTransaction("),
    slice("// ---- Script version selection for scheduled starts", "async function meterLiveUsage()"),
    workerSource.match(/^function runtimeVoiceIdValid.*$/m)[0],
    workerSource.match(/^function voiceChecksumValid.*$/m)[0]
  ].join("\n");
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const run = { id: "10000000-0000-4000-8000-0000000000a1", tenant_id: tenantId, show_revision_id: "10000000-0000-4000-8000-0000000000b1", trace_id: "trace-1", runtime_session_id: "session-1" };
  const segment = { id: "10000000-0000-4000-8000-0000000000c1", runtime_script: "主版本话术", runtime_script_variants: ["变体话术"] };
  const overlayJson = '{"caption":{"enabled":true}}';
  async function schedule(overlayRow) {
    const log = [];
    let transaction = 0;
    const client = { async query(text, params = []) {
      const sql = text.replace(/\s+/g, " ").trim();
      log.push({ sql, params, tx: transaction });
      if (/from live_runs where state = 'ARMED'/.test(sql)) return { rows: [run] };
      if (sql.startsWith("select id, runtime_script, runtime_script_variants from show_revision_segments")) return { rows: [segment] };
      if (sql.startsWith("select scene_json, scene_sha256 from show_revision_overlays")) return { rows: overlayRow ? [overlayRow] : [] };
      if (sql.includes("from show_revision_media_assets binding")) return { rows: [{ runtime_voice_id: "voice_1", checksum: `sha256:${"a".repeat(64)}` }] };
      if (sql.includes("from tenant_entitlements")) return { rows: [] };
      if (sql.startsWith("update runtime_alerts")) return { rows: [] };
      if (sql.includes("from show_revision_policy_profiles binding")) return { rows: [{ rules: [], evidence_ref: "evidence://test", validation_summary: "ok", approval_status: "approved" }] };
      if (sql.startsWith("select lexicon from show_revision_prohibited_term_snapshots")) return { rows: [] };
      if (sql.startsWith("select tenant_id, kind, builtin_term_id, term, normalized_term, category, approved_revision")) return { rows: [] };
      if (sql.startsWith("select variant_index, play_seq from live_run_script_plays")) return { rows: [] };
      if (sql.startsWith("insert into outbox_events")) return { rows: [{ id: "10000000-0000-4000-8000-0000000000e1" }] };
      if (sql.startsWith("insert into runtime_alerts")) return { rows: [{ id: "alert-1" }] };
      if (sql.includes("runtime_worker_actor")) return { rows: [{ id: "actor-1" }] };
      if (/^(update live_runs|insert into live_run_script_plays|insert into audit_events)/.test(sql)) return { rows: [] };
      throw new Error(`unexpected worker query: ${sql}`);
    } };
    const build = new Function("deps", `const { tenantIds, inTenantTransaction, createHash, guardBroadcastText, parsePolicyRules, BUILTIN_LEXICON, effectiveLexicon, compileLexicon, runtimeLexicon, chooseScriptVariant, scriptVariantsProblem } = deps; let nextSchedulerTenantCursor = 0; ${scheduleSource} return scheduleDueRun;`);
    const scheduleDueRun = build({
      tenantIds: async () => [tenantId],
      inTenantTransaction: async (_tenantId, operation) => { transaction += 1; log.push({ sql: "begin", tx: transaction }); try { const result = await operation(client); log.push({ sql: "commit", tx: transaction }); return result; } catch (error) { log.push({ sql: "rollback", tx: transaction }); throw error; } },
      createHash, guardBroadcastText: workerGuard.guardBroadcastText, parsePolicyRules: workerPolicy.parsePolicyRules, BUILTIN_LEXICON: workerBuiltin.BUILTIN_LEXICON,
      effectiveLexicon: workerTerms.effectiveLexicon, compileLexicon: workerTerms.compileLexicon, runtimeLexicon: workerTerms.runtimeLexicon,
      chooseScriptVariant: workerRotation.chooseScriptVariant, scriptVariantsProblem: workerRotation.scriptVariantsProblem
    });
    const result = await scheduleDueRun();
    const outbox = log.find((entry) => entry.sql.startsWith("insert into outbox_events"));
    return { result, log, command: outbox ? JSON.parse(outbox.params[2]).command : null };
  }
  const frozen = { scene_json: overlayJson, scene_sha256: digest(overlayJson) };
  const good = await schedule(frozen);
  assert.equal(good.command.payload.controlAction, "SCHEDULED_START");
  assert.equal(good.command.payload.overlaySceneJson, overlayJson);
  assert.equal(good.command.payload.overlaySceneSha256, digest(overlayJson));
  const sceneQuery = good.log.find((entry) => entry.sql.startsWith("select scene_json, scene_sha256 from show_revision_overlays"));
  assert.equal(sceneQuery.tx, good.log.find((entry) => entry.sql === "commit").tx, "overlay read shares the scheduling transaction");
  const absent = await schedule(null);
  assert.equal("overlaySceneJson" in absent.command.payload, false, "legacy scheduled payload remains unchanged without a frozen scene");
  const damaged = await schedule({ ...frozen, scene_sha256: "0".repeat(64) });
  assert.equal(damaged.result, null);
  assert.equal(damaged.command, null, "damaged scene creates no SCHEDULED_START outbox event");
  assert.equal(damaged.log.filter((entry) => entry.sql.startsWith("update live_runs set scheduled_at = null")).length, 1);

  const dispatchSource = slice("function deliveryRequest(", "function commandIdValid(");
  const validators = ["function commandIdValid", "function sessionIdValid", "function runtimeVoiceIdValid", "function voiceChecksumValid", "function programSegmentIdValid"].map((name) => workerSource.match(new RegExp(`^${name}.*$`, "m"))[0]).join("\n");
  const deliveryRequest = new Function("createHash", `class DeliveryError extends Error {} ${validators} ${dispatchSource} return deliveryRequest;`)(createHash);
  const event = { event_type: "media.dispatch", payload: { sessionId: "session-1", command: good.command } };
  const delivery = deliveryRequest(event);
  assert.equal(delivery.body.overlay_scene_json, overlayJson);
  assert.equal(delivery.body.overlay_scene_sha256, digest(overlayJson));
  for (const type of ["insert_program", "resume_program"]) {
    const transition = { ...event, payload: { sessionId: "session-1", command: { ...good.command, type, payload: { programSegmentId: segment.id, runtimeScript: "话术", scriptSha256: digest("话术"), runtimeVoiceId: "voice_1", voiceChecksum: good.command.payload.voiceChecksum } } } };
    const body = deliveryRequest(transition).body;
    assert.equal("overlay_scene_json" in body, false);
    assert.equal("overlay_scene_sha256" in body, false);
  }
  const receiptSource = workerSource.match(/function assertMediaGatewayReceipt\([\s\S]*?\n\}/)[0];
  const receiptCheck = new Function("DeliveryError", "RECEIPT_CLOCK_SKEW_MS", `${receiptSource}; return assertMediaGatewayReceipt;`)(class extends Error {}, 30_000);
  const validReceipt = { accepted: true, receipt: { command_id: good.command.id, session_id: "session-1", action: "start_program", accepted_at: new Date().toISOString(), program_segment_id: segment.id, overlay_scene_sha256: digest(overlayJson) } };
  assert.equal(receiptCheck(validReceipt, good.command, "session-1", new Date(Date.now() - 1000).toISOString()).overlay_scene_sha256, digest(overlayJson));
  for (const hash of [undefined, "f".repeat(64)]) {
    const invalid = structuredClone(validReceipt);
    if (hash === undefined) delete invalid.receipt.overlay_scene_sha256; else invalid.receipt.overlay_scene_sha256 = hash;
    assert.throws(() => receiptCheck(invalid, good.command, "session-1", new Date(Date.now() - 1000).toISOString()), /does not bind the media command/);
  }
});
