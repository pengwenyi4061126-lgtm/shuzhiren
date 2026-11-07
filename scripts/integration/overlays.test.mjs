// Frozen overlay persistence, approval, dispatch and worker privileges (migrations 089-090).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";
import { MEDIA_KINDS, MODEL_COMPONENTS } from "./lib/seed.mjs";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const capabilities = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsOutboundReplies: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
let h;
let store;
let revisions;
let interactionRules;
let aigc;
let worker;

before(async () => {
  h = await createHarness(import.meta.url);
  const gateway = await h.stub();
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY", "AIGC_LABEL_TEXT"]) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: h.url("control_plane"), RUNTIME_GATEWAY_URL: gateway.baseUrl, RUNTIME_GATEWAY_DEMO_MODE: "false", AIGC_CONTENT_PRODUCER: "Integration Operator" });
  register("../lib/console-ts-loader.mjs", import.meta.url);
  store = await import("../../apps/console/lib/control-plane/store.ts");
  revisions = await import("../../apps/console/lib/show-program-revisions.ts");
  interactionRules = await import("../../apps/console/lib/interaction-rules.ts");
  aigc = await import("../../apps/console/lib/aigc-label.ts");
  worker = await h.connectAs("runtime_worker");
  gateway.route("GET", "/healthz", () => ({ status: 200, json: { status: "ok", dependencies: { livetalking: { available: true, aigc_label: { enabled: true, text: aigc.aigcLabelText(), position: "top-right", frames_labelled: 250, last_error: null }, overlay: { supported: true, aigc_position: "top-right" } } } } }));
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await worker?.end().catch(() => undefined);
  await h?.close();
});

async function fixture({ backgroundApproved = true } = {}) {
  const { seed, admin } = h;
  const tenantId = await seed.tenant();
  const subject = `it-overlay-${randomUUID()}`;
  const memberId = await seed.member({ tenantId, subject, role: "admin", displayName: "画面层集成测试" });
  const reviewerSubject = `it-overlay-reviewer-${randomUUID()}`;
  const reviewerId = await seed.member({ tenantId, subject: reviewerSubject, role: "reviewer" });
  const revision = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false, segments: [] });
  const productVersionId = await seed.productVersion({ tenantId, approver: memberId, facts: { priceCent: 12800, stock: 12, validUntil: "2099-12-31T23:59:59.000Z", sourceRef: "evidence://integration/overlay-product", sourceSyncedAt: new Date().toISOString(), validFrom: new Date(Date.now() - 60_000).toISOString() } });
  await admin.query("update products set name = '集成洁面产品' where id = (select product_id from product_versions where id = $1)", [productVersionId]);
  await admin.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revision.revisionId, productVersionId]);
  for (const component of MODEL_COMPONENTS) {
    const id = await seed.modelRelease({ tenantId, approver: memberId, component });
    await admin.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revision.revisionId, id, component]);
  }
  for (const kind of MEDIA_KINDS) {
    const id = await seed.mediaAsset({ tenantId, approver: memberId, kind });
    await admin.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revision.revisionId, id, kind]);
  }
  const policyId = await seed.policyProfile({ tenantId, approver: memberId });
  await admin.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revision.revisionId, policyId]);
  const segmentIds = { primary: randomUUID(), interactive: randomUUID(), fallback: randomUUID(), handoff: randomUUID() };
  const segments = [
    [segmentIds.primary, 1, "prepared_product", "产品讲解", productVersionId, "介绍已批准的产品信息。", false],
    [segmentIds.interactive, 2, "interactive", "受控互动", productVersionId, "回答可追溯的问题。", false],
    [segmentIds.fallback, 3, "fallback", "备用节目", productVersionId, null, true],
    [segmentIds.handoff, 4, "human_handoff", "人工接管", null, null, true]
  ];
  for (const [id, position, kind, title, version, script, fallback] of segments) {
    await admin.query("insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, product_version_id, runtime_script, is_fallback) values ($1, $2, $3, $4, $5::program_segment_kind, $6, 'overlay integration', 120, $7, $8, $9)", [id, tenantId, revision.revisionId, position, kind, title, version, script, fallback]);
  }
  const channelId = await seed.channelConnection({ tenantId, verifier: memberId, capabilities });
  const runId = await seed.liveRun({ tenantId, revisionId: revision.revisionId, state: "DRAFT", channelId, productVersionId });
  const context = { tenantId, actorId: subject, actorName: "画面层集成测试", role: "admin", accessScope: "tenant" };
  const backgroundId = await seed.mediaAsset({ tenantId, approver: memberId, kind: "overlay_background", approve: backgroundApproved });
  await admin.query("insert into show_revision_overlays (tenant_id, show_revision_id, caption_enabled, caption_position, product_card_enabled, product_card_anchor, price_sticker_enabled, background_mode, background_media_asset_id, background_options, updated_by) values ($1, $2, true, 'bottom_band', true, 'middle-right', true, 'canvas', $3, '{\"avatarAnchor\":\"left\",\"avatarScalePermille\":800}'::jsonb, $4)", [tenantId, revision.revisionId, backgroundId, memberId]);
  return { tenantId, subject, memberId, reviewerSubject, reviewerId, revisionId: revision.revisionId, showId: revision.showId, productVersionId, segmentIds, channelId, runId, context, backgroundId };
}

async function rejected(client, sql, params = []) {
  await client.query("savepoint overlay_probe");
  try { await client.query(sql, params); return null; }
  catch (error) { return error.message; }
  finally { await client.query("rollback to savepoint overlay_probe"); }
}

describe("PostgreSQL overlay configuration and frozen scenes", () => {
  test("console approval freezes approved inputs and database immutability protects the scene", async () => {
    const f = await fixture();
    await store.advanceRunLifecycle(f.context, f.runId, "submit_review");
    const approved = await store.advanceRunLifecycle(f.context, f.runId, "approve");
    const [scene] = await h.snapshot("select scene_json, scene_sha256, frozen_at from show_revision_overlays where show_revision_id = $1", [f.revisionId]);
    assert.ok(scene.frozen_at);
    assert.equal(scene.scene_sha256.trim(), sha256(scene.scene_json));
    const parsed = JSON.parse(scene.scene_json);
    assert.equal(parsed.productCard.title, "集成洁面产品");
    assert.equal(parsed.priceSticker.priceText, "¥128.00");
    assert.equal(approved.state, "APPROVED");
    assert.match(await rejected(h.admin, "update show_revision_overlays set caption_enabled = false where show_revision_id = $1", [f.revisionId]), /Frozen show revision overlays are immutable/);
    const request = await revisions.createProgramRevisionRequest(f.context, f.runId);
    const [candidate] = await h.snapshot("select scene_json, scene_sha256, frozen_at from show_revision_overlays where show_revision_id = $1", [request.candidateRevisionId]);
    assert.deepEqual(candidate, { scene_json: null, scene_sha256: null, frozen_at: null }, "cloned candidate starts with editable configuration and no frozen scene");
  });

  test("unapproved backgrounds block approval, and enabled unfrozen overlays block direct revision approval", async () => {
    const f = await fixture({ backgroundApproved: false });
    await store.advanceRunLifecycle(f.context, f.runId, "submit_review");
    const error = await store.advanceRunLifecycle(f.context, f.runId, "approve").then(() => null, (value) => value);
    assert.ok(error instanceof Response && error.status === 422);
    assert.equal((await h.snapshot("select approval_status from show_revisions where id = $1", [f.revisionId]))[0].approval_status, "draft");

    const second = await fixture();
    const direct = await rejected(h.admin, "update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [second.revisionId, second.memberId]);
    assert.match(direct, /Approved show revisions with enabled overlays require a frozen scene/);
    assert.equal((await h.snapshot("select approval_status from show_revisions where id = $1", [second.revisionId]))[0].approval_status, "draft");
  });

  test("worker receives only overlay columns, cannot write them, and RLS hides another tenant", async () => {
    const f = await fixture();
    const otherTenant = await h.seed.tenant();
    await h.withTenant(worker, f.tenantId, async (client) => {
      const row = await client.query("select tenant_id, show_revision_id, scene_json, scene_sha256 from show_revision_overlays where show_revision_id = $1", [f.revisionId]);
      assert.equal(row.rows.length, 1);
      assert.match(await rejected(client, "select caption_enabled from show_revision_overlays where show_revision_id = $1", [f.revisionId]), /permission denied/);
      assert.match(await rejected(client, "update show_revision_overlays set scene_json = null where show_revision_id = $1", [f.revisionId]), /permission denied/);
    });
    await h.withTenant(worker, otherTenant, async (client) => {
      const rows = await client.query("select tenant_id, show_revision_id, scene_json, scene_sha256 from show_revision_overlays where show_revision_id = $1", [f.revisionId]);
      assert.equal(rows.rows.length, 0);
    });
  });

  test("START dispatch binds the frozen overlay while INSERT_PROGRAM omits it", async () => {
    const f = await fixture();
    await store.advanceRunLifecycle(f.context, f.runId, "submit_review");
    await store.advanceRunLifecycle(f.context, f.runId, "approve");
    const ruleContext = { ...f.context, role: "admin" };
    const { created } = await interactionRules.createDefaultInteractionRules(ruleContext);
    for (const rule of created) await interactionRules.approveInteractionRule(ruleContext, rule.id);
    const runId = await h.seed.liveRun({ tenantId: f.tenantId, revisionId: f.revisionId, state: "ARMED", channelId: f.channelId, productVersionId: f.productVersionId });
    await h.admin.query("update live_runs set has_operator = true, rights_approved = true, has_approved_sku_version = true, has_fallback_program = true, channel_ready = true, output_ready = true, ai_disclosure_enabled = true where id = $1", [runId]);
    await h.seed.healthSample({ tenantId: f.tenantId, liveRunId: runId });
    const result = await store.issueCommand(f.context, runId, { action: "START", expectedState: "ARMED", idempotencyKey: `it-overlay-${randomUUID()}` });
    const [start] = await h.snapshot("select payload from outbox_events where id = $1 and event_type = 'media.dispatch'", [result.mediaEvent.id]);
    const startCommand = start.payload.command;
    assert.equal(startCommand.payload.overlaySceneJson, (await h.snapshot("select scene_json from show_revision_overlays where show_revision_id = $1", [f.revisionId]))[0].scene_json);
    assert.equal(startCommand.payload.overlaySceneSha256, sha256(startCommand.payload.overlaySceneJson));
    await h.admin.query("update live_runs set state = 'LIVE', scheduled_start_event_id = null, active_program_segment_id = $2 where id = $1", [runId, f.segmentIds.primary]);
    const inserted = await store.issueCommand(f.context, runId, { action: "INSERT_PROGRAM", expectedState: "LIVE", idempotencyKey: `it-overlay-${randomUUID()}`, programSegmentId: f.segmentIds.interactive });
    const [insertEvent] = await h.snapshot("select payload from outbox_events where id = $1 and event_type = 'media.dispatch'", [inserted.mediaEvent.id]);
    assert.equal("overlaySceneJson" in insertEvent.payload.command.payload, false);
    assert.equal("overlaySceneSha256" in insertEvent.payload.command.payload, false);
  });
});
