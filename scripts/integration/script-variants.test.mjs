// Script variants and the rotation ledger (live-commerce-p1-features, task 7.11; requirements 3.2, 3.3, 3.6, 3.10,
// 3.11, 7.9; migration 085) against a real PostgreSQL cluster. The console store runs as shuzhiren_control_plane
// (no SUPERUSER, no BYPASSRLS), the ledger privilege checks as shuzhiren_runtime_worker. Covered here: variants in a
// draft revision and their freeze at approval, START -> INSERT_PROGRAM -> ROLLBACK_PROGRAM -> RECOVER rotation in
// live_run_script_plays, copying of all variants into a program change request, tenant isolation of the ledger and
// the append-only ledger grants. "A variant with a blocked term makes approval answer 422" is added by task 8.1.
//
// Not covered: the runtime worker's scheduleDueRun path. It runs `select ... for update` on tenant_entitlements,
// which needs UPDATE privilege, but service-principals.sql grants the worker SELECT only (a defect that predates
// this batch, from commits 9901b2d and 8611851). The worker's rotation logic is covered with a fake client in
// scripts/test-script-variants.mjs; this file only checks the worker's privileges on the ledger itself.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { register } from "node:module";
import { after, before, describe, test } from "node:test";
import { createHarness } from "./harness.mjs";
import { MEDIA_KINDS, MODEL_COMPONENTS } from "./lib/seed.mjs";

let h;
let store;
let rules;
let database;
let aigc;
let program;
let revisions;
let plays;
let gateway;

const CHANNEL_CAPABILITIES = { channel: "integration-webhook", supportsRtmp: true, supportsSrt: false, supportsComments: true, supportsOutboundReplies: true, supportsProductPins: false, requiresAiDisclosure: true, maxResolution: "1080p", supportsReplay: false, supportsWebhook: true };
const gatewayLabel = (text) => ({ status: "ok", dependencies: { livetalking: { available: true, aigc_label: { enabled: true, text, position: "top-right", frames_labelled: 250, last_error: null } } } });
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// The runnable segments carry extra versions: A has two (three versions in all), B has none (one version).
const SCRIPT_A = "本段只讲解已批准的商品事实。";
const VARIANTS_A = ["换一种说法讲解商品事实。", "再换一种口吻介绍商品事实。"];
const SCRIPT_B = "本段只回答低风险且可追溯的问题。";

before(async () => {
  h = await createHarness(import.meta.url);
  gateway = await h.stub();
  // The console modules read these when first used: connect them as the control plane, with a Gateway stub that
  // reports the AIGC label enabled, so that the rotation is the only behavior under test.
  for (const name of ["CONTROL_PLANE_DEMO_MODE", "CONTROL_PLANE_DEV_HEADER_IDENTITY", "AIGC_LABEL_TEXT"]) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: "development", DATABASE_URL: h.url("control_plane"), RUNTIME_GATEWAY_URL: gateway.baseUrl, RUNTIME_GATEWAY_DEMO_MODE: "false", AIGC_CONTENT_PRODUCER: "Integration Operator" });
  register("../lib/console-ts-loader.mjs", import.meta.url);
  store = await import("../../apps/console/lib/control-plane/store.ts");
  rules = await import("../../apps/console/lib/interaction-rules.ts");
  database = await import("../../apps/console/lib/database.ts");
  aigc = await import("../../apps/console/lib/aigc-label.ts");
  program = await import("../../apps/console/lib/show-program.ts");
  revisions = await import("../../apps/console/lib/show-program-revisions.ts");
  plays = await import("../../apps/console/lib/script-plays.ts");
  assert.ok(database.databasePool(), "the console must be connected to PostgreSQL");
  gateway.route("GET", "/healthz", () => ({ status: 200, json: gatewayLabel(aigc.aigcLabelText()) }));
});

after(async () => {
  await globalThis.shuzhirenDatabasePool?.end().catch(() => undefined);
  await h?.close();
});

/** Inserts the four program segments of a revision: A and B are runnable, then a fallback and a human handoff. */
async function insertSegments(client, { tenantId, revisionId, productVersionId, variantsA = VARIANTS_A }) {
  const ids = { a: randomUUID(), b: randomUUID(), fallback: randomUUID(), handoff: randomUUID() };
  const rows = [
    [ids.a, 1, "prepared_product", "商品讲解", 180, productVersionId, SCRIPT_A, variantsA, false],
    [ids.b, 2, "interactive", "受控互动", 120, productVersionId, SCRIPT_B, [], false],
    [ids.fallback, 3, "fallback", "备用节目", 150, productVersionId, null, [], true],
    [ids.handoff, 4, "human_handoff", "人工接管", 0, null, null, [], true]
  ];
  for (const [id, position, kind, title, duration, pv, script, variants, fallback] of rows) {
    await client.query("insert into show_revision_segments (id, tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, product_version_id, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, $3, $4, $5::program_segment_kind, $6, '集成测试', $7, $8, $9, $10::jsonb, $11)", [id, tenantId, revisionId, position, kind, title, duration, pv, script, JSON.stringify(variants), fallback]);
  }
  return ids;
}

/**
 * A tenant with one run in `state` whose other START inputs all pass (frozen product facts, model releases, media
 * rights with an approved voice, policy profile, connected channel, fresh health sample, bound runtime session,
 * operator) and an approved revision whose segment A carries two extra script versions.
 */
async function fixture({ state = "ARMED", withRules = state === "ARMED" } = {}) {
  const { seed, admin } = h;
  const tenantId = await seed.tenant();
  const subject = `it-sv-${randomUUID()}`;
  const memberId = await seed.member({ tenantId, subject, displayName: "话术轮换测试场控", role: "operator" });
  const revision = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false, segments: [] });
  const { revisionId } = revision;
  const now = Date.now();
  const facts = { priceCent: 9900, stock: 20, highlights: ["按压泡沫"], faq: [], sourceRef: "pim://integration/script-variants", sourceSyncedAt: new Date(now).toISOString(), validFrom: new Date(now - 5 * 60_000).toISOString() };
  const productVersionId = await seed.productVersion({ tenantId, approver: memberId, facts });
  await admin.query("insert into show_revision_product_versions (tenant_id, show_revision_id, product_version_id, slot_key) values ($1, $2, $3, 'primary')", [tenantId, revisionId, productVersionId]);
  for (const component of MODEL_COMPONENTS) {
    const releaseId = await seed.modelRelease({ tenantId, approver: memberId, component });
    await admin.query("insert into show_revision_model_releases (tenant_id, show_revision_id, model_release_id, component) values ($1, $2, $3, $4::model_release_component)", [tenantId, revisionId, releaseId, component]);
  }
  for (const kind of MEDIA_KINDS) {
    const assetId = await seed.mediaAsset({ tenantId, approver: memberId, kind });
    await admin.query("insert into show_revision_media_assets (tenant_id, show_revision_id, media_asset_id, kind) values ($1, $2, $3, $4::media_asset_kind)", [tenantId, revisionId, assetId, kind]);
  }
  const policyProfileId = await seed.policyProfile({ tenantId, approver: memberId });
  await admin.query("insert into show_revision_policy_profiles (tenant_id, show_revision_id, policy_profile_id) values ($1, $2, $3)", [tenantId, revisionId, policyProfileId]);
  // The variants are written while the revision is still a draft without a run: the segment trigger allows inserts only then.
  const segmentIds = await insertSegments(admin, { tenantId, revisionId, productVersionId });
  await admin.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1", [revisionId, memberId]);
  const channelId = await seed.channelConnection({ tenantId, verifier: memberId, capabilities: CHANNEL_CAPABILITIES });
  const runId = await seed.liveRun({ tenantId, revisionId, state, channelId, productVersionId });
  await admin.query("update live_runs set has_operator = true, rights_approved = true, has_approved_sku_version = true, has_fallback_program = true, channel_ready = true, output_ready = true, ai_disclosure_enabled = true where id = $1", [runId]);
  await seed.healthSample({ tenantId, liveRunId: runId });
  const context = { tenantId, actorId: subject, actorName: "话术轮换测试场控", role: "operator", accessScope: "tenant" };
  if (withRules) {
    const adminContext = { ...context, role: "admin" };
    const { created } = await rules.createDefaultInteractionRules(adminContext);
    for (const rule of created) await rules.approveInteractionRule(adminContext, rule.id);
  }
  return { tenantId, memberId, runId, revisionId, productVersionId, segmentIds, context };
}

const command = (f, action, expectedState, extra = {}) => store.issueCommand(f.context, f.runId, { action, expectedState, idempotencyKey: `it-sv-${randomUUID()}`, ...extra });

/** What the runtime's confirmation would do to the run (outbox.ts): a stand-in, since no Gateway runs here. */
const confirm = (f, sql, params = []) => h.admin.query(sql, [f.runId, ...params]);
const confirmActivation = (f, segmentId) => confirm(f, "update live_runs set state = 'LIVE', scheduled_start_event_id = null, active_program_segment_id = $2::uuid, updated_at = now() where id = $1", [segmentId]);
const confirmInsert = (f, targetId, sourceId) => confirm(f, "update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = $3::uuid, active_insert_program_segment_id = $2::uuid, pending_program_transition_event_id = null, updated_at = now() where id = $1", [targetId, sourceId]);
const confirmRollback = (f, targetId) => confirm(f, "update live_runs set active_program_segment_id = $2::uuid, active_insert_source_segment_id = null, active_insert_program_segment_id = null, pending_program_transition_event_id = null, updated_at = now() where id = $1", [targetId]);

const ledgerRows = (f) => h.snapshot("select p.play_seq, p.variant_index, p.variant_count, p.script_sha256, p.control_action, p.outbox_event_id, p.skipped_variant_indexes, p.segment_id from live_run_script_plays p where p.live_run_id = $1 order by p.created_at, p.play_seq", [f.runId]);

let rotation;
/** START -> INSERT_PROGRAM -> ROLLBACK_PROGRAM -> PAUSE -> RECOVER -> INSERT_PROGRAM -> ROLLBACK_PROGRAM, run once. */
function rotationRun() {
  rotation ??= (async () => {
    const f = await fixture();
    const { a, b } = f.segmentIds;
    await command(f, "START", "ARMED");
    await confirmActivation(f, a);
    await command(f, "INSERT_PROGRAM", "LIVE", { programSegmentId: b });
    await confirmInsert(f, b, a);
    await command(f, "ROLLBACK_PROGRAM", "LIVE");
    await confirmRollback(f, a);
    await command(f, "PAUSE", "LIVE");
    await h.seed.healthSample({ tenantId: f.tenantId, liveRunId: f.runId });
    await command(f, "RECOVER", "DEGRADED");
    await confirmActivation(f, a);
    await command(f, "INSERT_PROGRAM", "LIVE", { programSegmentId: b });
    await confirmInsert(f, b, a);
    await command(f, "ROLLBACK_PROGRAM", "LIVE");
    await confirmRollback(f, a);
    return f;
  })();
  return rotation;
}

describe("variants are stored in the draft revision and frozen at approval", () => {
  test("a draft revision accepts up to four variants, and the check constraint refuses malformed lists", async () => {
    const { seed, admin } = h;
    const tenantId = await seed.tenant();
    const memberId = await seed.member({ tenantId, role: "operator" });
    const productVersionId = await seed.productVersion({ tenantId, approver: memberId });
    const expectRejected = async (revisionId, kind, script, variants, label) => {
      await admin.query("savepoint expect_rejected");
      try {
        await admin.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, product_version_id, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, 1, $3::program_segment_kind, 't', 'p', 60, $4, $5, $6::jsonb, $7)", [tenantId, revisionId, kind, productVersionId, script, JSON.stringify(variants), kind === "fallback"]);
        assert.fail(`${label} must be rejected`);
      } catch (error) {
        assert.equal(error.code, "23514", `${label}: ${error.message}`);
      } finally {
        await admin.query("rollback to savepoint expect_rejected");
        await admin.query("release savepoint expect_rejected");
      }
    };
    await admin.query("begin");
    try {
      const four = ["一", "二", "三", "四"].map((word) => `版本${word}的话术`);
      const draft = await seed.revision({ tenantId, approver: memberId, bindings: "none", approve: false, segments: [] });
      await expectRejected(draft.revisionId, "prepared_product", SCRIPT_A, [...four, "第五个版本的话术"], "five variants");
      await expectRejected(draft.revisionId, "prepared_product", SCRIPT_A, ["重复", "重复"], "duplicate variants");
      await expectRejected(draft.revisionId, "prepared_product", SCRIPT_A, [SCRIPT_A], "a variant equal to the primary script");
      await expectRejected(draft.revisionId, "prepared_product", SCRIPT_A, ["x".repeat(801)], "an 801-character variant");
      await expectRejected(draft.revisionId, "prepared_product", SCRIPT_A, [" \t"], "a blank variant");
      await expectRejected(draft.revisionId, "fallback", null, ["备用版本"], "a variant on a segment that is not runnable");
      await admin.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, purpose, duration_seconds, product_version_id, runtime_script, runtime_script_variants, is_fallback) values ($1, $2, 1, 'prepared_product', 't', 'p', 60, $3, $4, $5::jsonb, false)", [tenantId, draft.revisionId, productVersionId, SCRIPT_A, JSON.stringify(four)]);
      const stored = await admin.query("select runtime_script_variants from show_revision_segments where show_revision_id = $1", [draft.revisionId]);
      assert.deepEqual(stored.rows[0].runtime_script_variants, four);
    } finally {
      await admin.query("rollback");
    }
  });

  test("after approval the variants cannot be changed, replaced or deleted (segment trigger)", async () => {
    const f = await fixture({ state: "PREFLIGHT", withRules: false });
    const before = await h.snapshot("select id, runtime_script_variants from show_revision_segments where show_revision_id = $1 order by position", [f.revisionId]);
    assert.deepEqual(before[0].runtime_script_variants, VARIANTS_A, "the approved revision holds the variants written in the draft");
    for (const [label, sql] of [
      ["update of the variants", "update show_revision_segments set runtime_script_variants = '[\"改写后的版本\"]'::jsonb where id = $1"],
      ["removal of the variants", "update show_revision_segments set runtime_script_variants = '[]'::jsonb where id = $1"],
      ["deletion of the segment", "delete from show_revision_segments where id = $1"]
    ]) {
      await assert.rejects(h.admin.query(sql, [f.segmentIds.a]), (error) => error.code === "P0001" && /editable only/.test(error.message), label);
    }
    assert.deepEqual(await h.snapshot("select id, runtime_script_variants from show_revision_segments where show_revision_id = $1 order by position", [f.revisionId]), before, "the stored variants are unchanged");
  });
});

describe("rotation across START, INSERT_PROGRAM, ROLLBACK_PROGRAM and RECOVER", () => {
  test("play_seq counts per segment and the version index follows the round-robin order, wrapping after the last version", async () => {
    const f = await rotationRun();
    const { a, b } = f.segmentIds;
    const rows = await ledgerRows(f);
    // Segment A has three versions: START 0, ROLLBACK_PROGRAM 1, RECOVER 2, ROLLBACK_PROGRAM wraps to 0.
    // Segment B has one version, so every insertion uses version 0.
    assert.deepEqual(rows.map((row) => [row.segment_id === a ? "A" : row.segment_id === b ? "B" : "?", row.control_action, row.play_seq, row.variant_index, row.variant_count, row.skipped_variant_indexes]), [
      ["A", "START", 1, 0, 3, []],
      ["B", "INSERT_PROGRAM", 1, 0, 1, []],
      ["A", "ROLLBACK_PROGRAM", 2, 1, 3, []],
      ["A", "RECOVER", 3, 2, 3, []],
      ["B", "INSERT_PROGRAM", 2, 0, 1, []],
      ["A", "ROLLBACK_PROGRAM", 4, 0, 3, []]
    ]);
    const texts = [SCRIPT_A, ...VARIANTS_A];
    for (const row of rows) {
      const expected = row.segment_id === a ? texts[row.variant_index] : SCRIPT_B;
      assert.equal(row.script_sha256, sha256(expected), `${row.control_action} #${row.play_seq} records the hash of the version it dispatched`);
    }
  });

  test("each ledger row belongs to the media.dispatch event that carries the same text, hash and version index", async () => {
    const f = await rotationRun();
    const rows = await ledgerRows(f);
    const events = await h.snapshot("select id, event_type, payload from outbox_events where aggregate_id = $1 and event_type = 'media.dispatch'", [f.runId]);
    const byId = new Map(events.map((event) => [event.id, event.payload.command.payload]));
    for (const row of rows) {
      const payload = byId.get(row.outbox_event_id);
      assert.ok(payload, `outbox event ${row.outbox_event_id} exists and is a media.dispatch`);
      assert.equal(payload.controlAction, row.control_action);
      assert.equal(payload.programSegmentId, row.segment_id);
      assert.equal(payload.scriptVariantIndex, String(row.variant_index));
      assert.equal(payload.scriptSha256, row.script_sha256);
      assert.equal(sha256(payload.runtimeScript), row.script_sha256, "the dispatched text is the text the ledger hashed");
    }
    const audits = await h.snapshot("select detail from audit_events where tenant_id = $1 and event_type = 'program_script.variant_selected' and resource_key = $2 order by occurred_at", [f.tenantId, f.runId]);
    assert.equal(audits.length, rows.length, "one program_script.variant_selected audit event per ledger row");
    assert.deepEqual(audits.map((event) => [event.detail.segmentId, String(event.detail.variantIndex), event.detail.scriptSha256, event.detail.playSeq]), rows.map((row) => [row.segment_id, String(row.variant_index), row.script_sha256, row.play_seq]));
  });

  test("GET script-plays returns the same rows as indexes and hashes, without the script text", async () => {
    const f = await rotationRun();
    const listed = await plays.listScriptPlays(f.context, f.runId);
    const rows = await ledgerRows(f);
    assert.deepEqual(listed.map((play) => [play.segmentId, play.playSeq, play.variantIndex, play.scriptSha256]).sort(), rows.map((row) => [row.segment_id, row.play_seq, row.variant_index, row.script_sha256]).sort());
    const serialized = JSON.stringify(listed);
    for (const text of [SCRIPT_A, ...VARIANTS_A, SCRIPT_B]) assert.ok(!serialized.includes(text), "the listing never contains script text");
  });
});

describe("a program change request copies every variant", () => {
  test("the candidate revision holds the same variants as the source, and an edit stores the new list", async () => {
    const f = await fixture({ state: "PREFLIGHT", withRules: false });
    const request = await revisions.createProgramRevisionRequest(f.context, f.runId);
    const read = async (revisionId) => (await h.snapshot("select position, kind, runtime_script, runtime_script_variants from show_revision_segments where show_revision_id = $1 order by position", [revisionId]));
    const source = await read(f.revisionId);
    const candidate = await read(request.candidateRevisionId);
    assert.notEqual(request.candidateRevisionId, f.revisionId);
    assert.deepEqual(candidate, source, "all four segments are copied, including every extra version");
    assert.deepEqual(candidate[0].runtime_script_variants, VARIANTS_A);
    assert.deepEqual(request.program.segments[0].runtimeScriptVariants, VARIANTS_A);
    // programHash covers the variants (and only for non-empty lists), so the hash recorded for the source revision
    // is the hash of the stored segments including both extra versions.
    assert.equal(request.sourceProgramSha256, program.programHash(request.program.segments));

    const edited = ["改写后的第一个版本。", "改写后的第二个版本。", "改写后的第三个版本。"];
    await revisions.replaceProgramRevisionRequest(f.context, f.runId, request.id, [
      { kind: "prepared_product", title: "商品讲解", durationSeconds: 180, purpose: "集成测试", runtimeScript: SCRIPT_A, runtimeScriptVariants: edited },
      { kind: "interactive", title: "受控互动", durationSeconds: 120, purpose: "集成测试", runtimeScript: SCRIPT_B },
      { kind: "fallback", title: "备用节目", durationSeconds: 150, purpose: "集成测试" },
      { kind: "human_handoff", title: "人工接管", durationSeconds: 0, purpose: "集成测试" }
    ]);
    assert.deepEqual((await read(request.candidateRevisionId)).map((row) => row.runtime_script_variants), [edited, [], [], []]);
    assert.deepEqual(await read(f.revisionId), source, "the approved source revision is not touched");
    const audit = await h.snapshot("select detail from audit_events where tenant_id = $1 and event_type = 'show_program_revision.updated' and resource_key = $2", [f.tenantId, request.id]);
    assert.equal(audit[0].detail.variantCount, 3);
  });
});

describe("the ledger is tenant scoped and append-only", () => {
  test("another tenant reads no ledger row (RLS), the owner tenant reads them all", async () => {
    const f = await rotationRun();
    const other = await h.seed.tenant();
    const client = await h.connectAs("control_plane");
    try {
      const own = await h.withTenant(client, f.tenantId, (c) => c.query("select count(*)::int as n from live_run_script_plays where live_run_id = $1", [f.runId]));
      assert.equal(own.rows[0].n, 6);
      const foreign = await h.withTenant(client, other, (c) => c.query("select count(*)::int as n from live_run_script_plays"));
      assert.equal(foreign.rows[0].n, 0, "the other tenant's context sees no ledger rows");
      const direct = await h.withTenant(client, other, (c) => c.query("select count(*)::int as n from live_run_script_plays where live_run_id = $1", [f.runId]));
      assert.equal(direct.rows[0].n, 0, "asking for the run by id does not help");
    } finally {
      await client.end();
    }
    await assert.rejects(plays.listScriptPlays({ ...f.context, tenantId: other }, f.runId), (error) => error instanceof Response && error.status === 404, "the listing of another tenant's run is a 404");
  });

  test("UPDATE and DELETE are rejected by the trigger even for a superuser, and the ledger is unchanged", async () => {
    const f = await rotationRun();
    const before = await ledgerRows(f);
    await assert.rejects(h.admin.query("update live_run_script_plays set variant_index = 0 where live_run_id = $1", [f.runId]), (error) => error.code === "P0001" && /append-only/.test(error.message));
    await assert.rejects(h.admin.query("delete from live_run_script_plays where live_run_id = $1", [f.runId]), (error) => error.code === "P0001" && /append-only/.test(error.message));
    assert.deepEqual(await ledgerRows(f), before);
  });

  test("an insert must describe a real dispatch: the next play_seq, the right hash and the version count", async () => {
    const f = await fixture({ state: "LIVE", withRules: false });
    const eventId = () => h.seed.outboxEvent({ tenantId: f.tenantId, aggregateId: f.runId });
    const insert = async (overrides) => {
      const row = { play_seq: 1, variant_index: 0, variant_count: 3, script_sha256: sha256(SCRIPT_A), segment_id: f.segmentIds.a, ...overrides };
      await h.admin.query("savepoint bad_play");
      try {
        await h.admin.query("insert into live_run_script_plays (tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id) values ($1, $2, $3, $4, $5, $6, $7, $8, 'START', $9)", [f.tenantId, f.runId, f.revisionId, row.segment_id, row.play_seq, row.variant_index, row.variant_count, row.script_sha256, await eventId()]);
      } catch (error) {
        await h.admin.query("rollback to savepoint bad_play");
        throw error;
      } finally {
        await h.admin.query("release savepoint bad_play").catch(() => undefined);
      }
    };
    await h.admin.query("begin");
    try {
      await assert.rejects(insert({ play_seq: 2 }), /sequence must follow/, "a gap in play_seq");
      await assert.rejects(insert({ script_sha256: sha256("别的话术") }), /hash does not match/, "a hash of another text");
      await assert.rejects(insert({ variant_count: 2 }), /variant count does not match/, "a wrong version count");
      await assert.rejects(insert({ segment_id: f.segmentIds.fallback, variant_count: 1 }), /runnable program segment/, "a segment that is not runnable");
      await insert({});
      await assert.rejects(insert({}), /sequence must follow|duplicate key/, "play_seq 1 again");
      await insert({ play_seq: 2, variant_index: 2, script_sha256: sha256(VARIANTS_A[1]) });
    } finally {
      await h.admin.query("rollback");
    }
  });

  test("the runtime worker can read and insert ledger rows but not update or delete them", async () => {
    const f = await fixture({ state: "LIVE", withRules: false });
    const outboxEventId = await h.seed.outboxEvent({ tenantId: f.tenantId, aggregateId: f.runId });
    const worker = await h.connectAs("runtime_worker");
    const expectDenied = async (sql, params, label) => {
      await worker.query("savepoint denied");
      try {
        await worker.query(sql, params);
        assert.fail(`${label} must be denied`);
      } catch (error) {
        assert.equal(error.code, "42501", `${label}: ${error.message}`);
      } finally {
        await worker.query("rollback to savepoint denied");
        await worker.query("release savepoint denied");
      }
    };
    try {
      await h.withTenant(worker, f.tenantId, async (c) => {
        const inserted = await c.query("insert into live_run_script_plays (tenant_id, live_run_id, show_revision_id, segment_id, play_seq, variant_index, variant_count, script_sha256, control_action, outbox_event_id) values ($1, $2, $3, $4, 1, 0, 3, $5, 'SCHEDULED_START', $6) returning id", [f.tenantId, f.runId, f.revisionId, f.segmentIds.a, sha256(SCRIPT_A), outboxEventId]);
        const read = await c.query("select play_seq, variant_index, control_action from live_run_script_plays where live_run_id = $1", [f.runId]);
        assert.deepEqual(read.rows, [{ play_seq: 1, variant_index: 0, control_action: "SCHEDULED_START" }]);
        await expectDenied("update live_run_script_plays set variant_index = 1 where id = $1", [inserted.rows[0].id], "UPDATE by the worker");
        await expectDenied("delete from live_run_script_plays where id = $1", [inserted.rows[0].id], "DELETE by the worker");
        await expectDenied("truncate live_run_script_plays", [], "TRUNCATE by the worker");
      });
      assert.deepEqual((await ledgerRows(f)).map((row) => row.play_seq), [1], "the committed row is still there");
    } finally {
      await worker.end();
    }
  });
});
