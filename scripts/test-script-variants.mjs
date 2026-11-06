// Behavioral tests for script variants (design.md module C). Run: node --test scripts/test-script-variants.mjs
import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  chooseScriptVariant,
  normalizeScriptVariants,
  scriptVariantsProblem
} from "../apps/console/lib/shared/script-rotation.mjs";

const scripts = ["主版本", "变体一", "变体二"];
const all = () => true;

test("chooseScriptVariant rotates through the versions (design.md Example Usage)", () => {
  assert.deepEqual(chooseScriptVariant({ scripts, lastVariantIndex: null, isAllowed: all }), { variantIndex: 0, skipped: [] });
  assert.deepEqual(chooseScriptVariant({ scripts, lastVariantIndex: 0, isAllowed: all }), { variantIndex: 1, skipped: [] });
  assert.deepEqual(chooseScriptVariant({ scripts, lastVariantIndex: 1, isAllowed: (script) => script !== "变体二" }), { variantIndex: 0, skipped: [2] });
});

test("chooseScriptVariant returns null when every version is refused", () => {
  assert.equal(chooseScriptVariant({ scripts, lastVariantIndex: 1, isAllowed: () => false }), null);
  assert.equal(chooseScriptVariant({ scripts: ["only"], lastVariantIndex: null, isAllowed: () => false }), null);
});

test("chooseScriptVariant with one version keeps choosing it and rejects invalid input", () => {
  assert.deepEqual(chooseScriptVariant({ scripts: ["only"], lastVariantIndex: 0, isAllowed: all }), { variantIndex: 0, skipped: [] });
  assert.throws(() => chooseScriptVariant({ scripts: [], lastVariantIndex: null, isAllowed: all }), RangeError);
  assert.throws(() => chooseScriptVariant({ scripts, lastVariantIndex: 3, isAllowed: all }), RangeError);
});

test("normalizeScriptVariants reads arrays and JSON text and yields [] otherwise", () => {
  assert.deepEqual(normalizeScriptVariants(["a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeScriptVariants('["a"]'), ["a"]);
  assert.deepEqual(normalizeScriptVariants(null), []);
  assert.deepEqual(normalizeScriptVariants("not json"), []);
  assert.deepEqual(normalizeScriptVariants({ 0: "a" }), []);
});

test("scriptVariantsProblem accepts 0-4 valid versions", () => {
  assert.equal(scriptVariantsProblem([], "主版本"), null);
  assert.equal(scriptVariantsProblem([], null), null);
  assert.equal(scriptVariantsProblem(["a", "b", "c", "d"], "主版本"), null);
  assert.equal(scriptVariantsProblem(["x".repeat(800)], "主版本"), null);
});

test("scriptVariantsProblem reports each broken rule", () => {
  assert.match(scriptVariantsProblem(["a", "b", "c", "d", "e"], "主版本"), /at most 4/);
  assert.match(scriptVariantsProblem(["a", "a"], "主版本"), /duplicates/);
  assert.match(scriptVariantsProblem(["主版本"], "主版本"), /differ from the primary/);
  assert.match(scriptVariantsProblem(["  \t\n"], "主版本"), /blank/);
  assert.match(scriptVariantsProblem([""], "主版本"), /1-800/);
  assert.match(scriptVariantsProblem(["x".repeat(801)], "主版本"), /1-800/);
  assert.match(scriptVariantsProblem([1], "主版本"), /must be a string/);
  assert.match(scriptVariantsProblem("a", "主版本"), /array/);
  assert.match(scriptVariantsProblem(["a"], null), /primary/);
});

// Feature: live-commerce-p1-features, Property 5: 多版本段落不连续重复
// Validates: Requirements 3.7
test("Property 5: with every version allowed, a multi-version segment never repeats the last version", () => {
  const scriptsArbitrary = fc.integer({ min: 2, max: 5 }).chain((count) => fc.record({
    scripts: fc.array(fc.string({ maxLength: 40 }), { minLength: count, maxLength: count }),
    lastVariantIndex: fc.integer({ min: 0, max: count - 1 })
  }));
  fc.assert(fc.property(scriptsArbitrary, ({ scripts: versions, lastVariantIndex }) => {
    const choice = chooseScriptVariant({ scripts: versions, lastVariantIndex, isAllowed: () => true });
    assert.notEqual(choice, null);
    assert.notEqual(choice.variantIndex, lastVariantIndex);
    assert.deepEqual(choice.skipped, []);
  }), { numRuns: 500, seed: 20250105 });
});

// Feature: live-commerce-p1-features, Property 6: 只选被允许的版本
// Validates: Requirements 3.6, 3.8
test("Property 6: only allowed versions are chosen, skipped lists the refused ones before it, null only when none is allowed", () => {
  const inputArbitrary = fc.integer({ min: 1, max: 5 }).chain((count) => fc.record({
    versions: fc.array(fc.string({ maxLength: 40 }), { minLength: count, maxLength: count }),
    lastVariantIndex: fc.option(fc.integer({ min: 0, max: count - 1 }), { nil: null }),
    allowedFlags: fc.array(fc.boolean(), { minLength: count, maxLength: count })
  }));
  fc.assert(fc.property(inputArbitrary, ({ versions, lastVariantIndex, allowedFlags }) => {
    const count = versions.length;
    const allowedIndexes = new Set(allowedFlags.flatMap((flag, index) => (flag ? [index] : [])));
    const choice = chooseScriptVariant({
      scripts: versions,
      lastVariantIndex,
      isAllowed: (script, index) => {
        assert.equal(script, versions[index]);
        return allowedIndexes.has(index);
      }
    });
    if (allowedIndexes.size === 0) {
      assert.equal(choice, null);
      return;
    }
    assert.notEqual(choice, null);
    assert.ok(allowedIndexes.has(choice.variantIndex));
    // The visiting order starts after the last version (or at 0) and wraps around.
    const start = lastVariantIndex === null ? 0 : (lastVariantIndex + 1) % count;
    const order = Array.from({ length: count }, (_, offset) => (start + offset) % count);
    const chosenAt = order.indexOf(choice.variantIndex);
    assert.deepEqual(choice.skipped, order.slice(0, chosenAt));
    assert.ok(choice.skipped.every((index) => !allowedIndexes.has(index)));
    assert.ok(order.slice(0, chosenAt).every((index) => !allowedIndexes.has(index)));
  }), { numRuns: 500, seed: 20250106 });
});

// Feature: live-commerce-p1-features, Property 7: 轮询顺序
// Validates: Requirements 3.6
test("Property 7: n consecutive calls from lastVariantIndex null with every version allowed yield 0, 1, ..., n-1", () => {
  const versionsArbitrary = fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 5 });
  fc.assert(fc.property(versionsArbitrary, (versions) => {
    const count = versions.length;
    const visited = [];
    let lastVariantIndex = null;
    for (let call = 0; call < count; call += 1) {
      const choice = chooseScriptVariant({ scripts: versions, lastVariantIndex, isAllowed: () => true });
      assert.notEqual(choice, null);
      assert.deepEqual(choice.skipped, []);
      visited.push(choice.variantIndex);
      lastVariantIndex = choice.variantIndex;
    }
    assert.deepEqual(visited, Array.from({ length: count }, (_, index) => index));
  }), { numRuns: 500, seed: 20250107 });
});

// Module C program storage: programHash compatibility and segment validation.
const { register } = await import("node:module");
register("./lib/console-ts-loader.mjs", import.meta.url);
const { normalizeProgramSegments, programHash } = await import("../apps/console/lib/show-program.ts");
const { programHash: referenceProgramHash } = await import("./fixtures/program-hash/f0fc02e-program-hash.mjs");
// Feature: live-commerce-p1-features, Property 8: 无变体节目的哈希不变
// Validates: Requirements 3.1, 3.5
test("Property 8: a program without extra versions hashes exactly as it did at f0fc02e", () => {
  const segmentArbitrary = fc.record({
    id: fc.string({ maxLength: 20 }),
    position: fc.integer({ min: 1, max: 20 }),
    kind: fc.constantFrom("prepared_product", "interactive", "fallback", "human_handoff"),
    title: fc.string({ maxLength: 60 }),
    durationSeconds: fc.integer({ min: 0, max: 3600 }),
    productVersionId: fc.option(fc.uuid(), { nil: undefined }),
    purpose: fc.string({ maxLength: 120 }),
    runtimeScript: fc.option(fc.string({ maxLength: 120 }), { nil: undefined }),
    fallback: fc.boolean()
  }, { requiredKeys: ["id", "position", "kind", "title", "durationSeconds", "purpose", "fallback"] });
  // "No extra versions" means the field is absent, undefined, null or an empty list.
  const noVariants = fc.constantFrom({}, { runtimeScriptVariants: undefined }, { runtimeScriptVariants: null }, { runtimeScriptVariants: [] });
  const programArbitrary = fc.array(fc.tuple(segmentArbitrary, noVariants).map(([segment, variants]) => ({ ...segment, ...variants })), { maxLength: 20 });
  fc.assert(fc.property(programArbitrary, (segments) => {
    assert.equal(programHash(segments), referenceProgramHash(segments));
  }), { numRuns: 500, seed: 20250108 });
});
test("programHash changes once a segment carries an extra version", () => {
  const segment = { id: "s1", position: 1, kind: "prepared_product", title: "t", durationSeconds: 30, productVersionId: "p", purpose: "x", runtimeScript: "主版本", fallback: false };
  assert.notEqual(programHash([{ ...segment, runtimeScriptVariants: ["变体一"] }]), referenceProgramHash([segment]));
  assert.notEqual(programHash([{ ...segment, runtimeScriptVariants: ["变体一"] }]), programHash([{ ...segment, runtimeScriptVariants: ["变体二"] }]));
});
const productVersionId = "00000000-0000-4000-8000-0000000000aa";
const programWith = (variants, overrides = {}) => [
  { kind: "prepared_product", title: "开场", durationSeconds: 60, purpose: "介绍商品", runtimeScript: "主版本", runtimeScriptVariants: variants, ...overrides },
  { kind: "fallback", title: "兜底", durationSeconds: 30, purpose: "兜底内容" },
  { kind: "human_handoff", title: "转人工", durationSeconds: 0, purpose: "人工接管" }
];
async function refusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 409);
    return error.text();
  }
  assert.fail("expected a 409 Response");
}
test("normalizeProgramSegments keeps 0-4 valid extra versions and hashes like the reference when none", async () => {
  assert.equal(normalizeProgramSegments(programWith([]), productVersionId)[0].runtimeScriptVariants, undefined);
  assert.equal(normalizeProgramSegments(programWith(undefined), productVersionId)[0].runtimeScriptVariants, undefined);
  assert.deepEqual(normalizeProgramSegments(programWith(["a", "b", "c", "d"]), productVersionId)[0].runtimeScriptVariants, ["a", "b", "c", "d"]);
  assert.deepEqual(normalizeProgramSegments(programWith(["  x  ", "x".repeat(800)]), productVersionId)[0].runtimeScriptVariants, ["x", "x".repeat(800)]);
  const plain = normalizeProgramSegments(programWith([]), productVersionId);
  assert.equal(programHash(plain), referenceProgramHash(plain));
});
test("normalizeProgramSegments refuses invalid extra versions with 409", async () => {
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["a", "b", "c", "d", "e"]), productVersionId)), /at most 4/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["a", "a"]), productVersionId)), /duplicates/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["主版本"]), productVersionId)), /differ from the primary/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["  主版本 "]), productVersionId)), /differ from the primary/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["x".repeat(801)]), productVersionId)), /1-800/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith(["   "]), productVersionId)), /1-800|blank/);
  assert.match(await refusal(() => normalizeProgramSegments(programWith("a"), productVersionId)), /array/);
});
test("normalizeProgramSegments refuses extra versions on non-runnable segments", async () => {
  const withFallbackVariants = programWith([]);
  withFallbackVariants[1].runtimeScriptVariants = ["变体一"];
  assert.match(await refusal(() => normalizeProgramSegments(withFallbackVariants, productVersionId)), /non-blank primary runtime script|cannot carry script variants/);
  const withHandoffVariants = programWith([]);
  withHandoffVariants[2].runtimeScriptVariants = ["变体一"];
  assert.match(await refusal(() => normalizeProgramSegments(withHandoffVariants, productVersionId)), /non-blank primary runtime script|cannot carry script variants/);
});

// Module C dispatch (demo mode): the console picks the next frozen script version for every script dispatch,
// records it in the rotation ledger and carries it (text, hash, index) in the media command.
process.env.CONTROL_PLANE_DEMO_MODE = "true";
const { createHash } = await import("node:crypto");
const controlStore = await import("../apps/console/lib/control-plane/store.ts");
const { registerDemoProgram } = await import("../apps/console/lib/show-program.ts");
const { listScriptPlays } = await import("../apps/console/lib/script-plays.ts");
const monitoring = await import("../apps/console/lib/monitoring.ts");
const { GET: scriptPlaysRoute } = await import("../apps/console/app/api/v1/live-runs/[runId]/script-plays/route.ts");
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const operator = { tenantId: "tenant_demo", actorId: "variant-test", actorName: "Variant Test", role: "operator", accessScope: "tenant" };
const segmentIds = { first: "20000000-0000-4000-8000-000000000001", second: "20000000-0000-4000-8000-000000000002" };
let runCounter = 0;
async function demoRunWith(state, segments, activeSegmentId) {
  await controlStore.listRuns(operator); // creates the demo store
  runCounter += 1;
  const id = `00000000-0000-4000-8000-0000000000c${runCounter}`;
  globalThis.shuzhirenControlStore.runs.set(id, {
    id, tenantId: operator.tenantId, revisionId: `show_revision_variants_${runCounter}`, channelConnectionId: "channel_demo", productVersionId: "pv_a102_v1", showName: "话术轮换", state,
    traceId: id, hasOperator: true, hasApprovedRights: true, hasApprovedSkuVersion: true, hasFallbackProgram: true, channelReady: true, outputReady: true, aiDisclosureEnabled: true,
    runtimeSessionId: `session_variants_${runCounter}`, activeProgramSegmentId: activeSegmentId, commandHistory: [], questions: []
  });
  registerDemoProgram({ runId: id, tenantId: operator.tenantId, revisionId: `show_revision_variants_${runCounter}`, status: "approved", editable: false, segments });
  // RECOVER needs fresh healthy runtime telemetry for the run.
  await monitoring.getTelemetry(operator, id);
  globalThis.shuzhirenMonitoringStore.telemetry.set(id, { runId: id, tenantId: operator.tenantId, sampledAt: new Date().toISOString(), outputConnected: true, inferenceFps: 30, outputFps: 25, avSyncMs: 30, bitrateMbps: 4, gpuUtilization: 70, gpuMemoryMiB: 14000, audioActive: true, fallbackReady: true });
  return id;
}
const runnable = (id, position, kind, runtimeScript, runtimeScriptVariants) => ({ id, position, kind, title: `段落${position}`, durationSeconds: 60, productVersionId: "pv_a102_v1", purpose: "话术轮换", runtimeScript, ...(runtimeScriptVariants ? { runtimeScriptVariants } : {}), fallback: false });
const fallbackSegments = [
  { id: "20000000-0000-4000-8000-000000000009", position: 3, kind: "fallback", title: "兜底", durationSeconds: 30, purpose: "兜底", fallback: true },
  { id: "20000000-0000-4000-8000-00000000000a", position: 4, kind: "human_handoff", title: "转人工", durationSeconds: 0, purpose: "转人工", fallback: true }
];
let commandCounter = 0;
const dispatch = (runId, action, expectedState, programSegmentId) => controlStore.issueCommand(operator, runId, { action, expectedState, idempotencyKey: `variant-command-${(commandCounter += 1)}-${runId}`, ...(programSegmentId ? { programSegmentId } : {}) });
const chosen = (result) => ({ index: result.mediaEvent.command.payload.scriptVariantIndex, script: result.mediaEvent.command.payload.runtimeScript, segment: result.mediaEvent.command.payload.programSegmentId });
const fixedProgram = (variants) => [
  runnable(segmentIds.first, 1, "prepared_product", "主版本话术", variants),
  runnable(segmentIds.second, 2, "interactive", "互动环节话术"),
  ...fallbackSegments
];

test("demo dispatch rotates START-less transitions through INSERT_PROGRAM, ROLLBACK_PROGRAM and RECOVER", async () => {
  const runId = await demoRunWith("LIVE", fixedProgram(["变体一话术", "变体二话术"]), segmentIds.first);
  const auditBefore = globalThis.shuzhirenAuditStore?.events.length ?? 0;
  const sequence = [];
  sequence.push(chosen(await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.second))); // second: one version
  sequence.push(chosen(await dispatch(runId, "ROLLBACK_PROGRAM", "LIVE"))); // back to first: version 0
  sequence.push(chosen(await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.second)));
  sequence.push(chosen(await dispatch(runId, "ROLLBACK_PROGRAM", "LIVE"))); // first again: version 1
  await dispatch(runId, "PAUSE", "LIVE");
  sequence.push(chosen(await dispatch(runId, "RECOVER", "DEGRADED"))); // first again: version 2
  assert.deepEqual(sequence, [
    { index: "0", script: "互动环节话术", segment: segmentIds.second },
    { index: "0", script: "主版本话术", segment: segmentIds.first },
    { index: "0", script: "互动环节话术", segment: segmentIds.second },
    { index: "1", script: "变体一话术", segment: segmentIds.first },
    { index: "2", script: "变体二话术", segment: segmentIds.first }
  ]);
  // The ledger lists every dispatch, newest first, with indexes and hashes but no script text.
  const plays = await listScriptPlays(operator, runId);
  assert.equal(plays.length, 5);
  assert.deepEqual(plays.map((play) => [play.segmentId === segmentIds.first ? "first" : "second", play.playSeq, play.variantIndex, play.variantCount, play.controlAction]), [
    ["first", 3, 2, 3, "RECOVER"], ["first", 2, 1, 3, "ROLLBACK_PROGRAM"], ["second", 2, 0, 1, "INSERT_PROGRAM"], ["first", 1, 0, 3, "ROLLBACK_PROGRAM"], ["second", 1, 0, 1, "INSERT_PROGRAM"]
  ]);
  assert.equal(plays[0].scriptSha256, sha256Hex("变体二话术"));
  assert.ok(plays.every((play) => !JSON.stringify(play).includes("话术")));
  const events = globalThis.shuzhirenAuditStore.events.slice(0, globalThis.shuzhirenAuditStore.events.length - auditBefore).filter((event) => event.type === "program_script.variant_selected" && event.resourceId === runId);
  assert.equal(events.length, 5);
  assert.deepEqual(events.find((event) => event.detail.variantIndex === 2).detail, {
    segmentId: segmentIds.first, variantIndex: 2, variantCount: 3, scriptSha256: sha256Hex("变体二话术"), playSeq: 3, outboxEventId: plays[0].outboxEventId, skippedVariantIndexes: "", controlAction: "RECOVER"
  });
});

test("the media command carries the hash of the selected version", async () => {
  const runId = await demoRunWith("LIVE", fixedProgram(["变体一话术"]), segmentIds.second);
  const first = await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.first);
  assert.equal(first.mediaEvent.command.payload.runtimeScript, "主版本话术");
  assert.equal(first.mediaEvent.command.payload.scriptSha256, sha256Hex("主版本话术"));
  await dispatch(runId, "ROLLBACK_PROGRAM", "LIVE");
  const second = await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.first);
  assert.equal(second.mediaEvent.command.payload.runtimeScript, "变体一话术");
  assert.equal(second.mediaEvent.command.payload.scriptSha256, sha256Hex("变体一话术"));
  assert.equal(second.mediaEvent.command.payload.scriptVariantIndex, "1");
});

test("START selects version 0 first and the block-listed version is skipped on later dispatches", async () => {
  // START in demo mode needs a verified channel and an approved AI disclosure rule (the preflight checks).
  const { validateChannelConnection } = await import("../apps/console/lib/channels.ts");
  await validateChannelConnection(operator, "channel_demo", { resolution: "720p", aiDisclosureEnabled: true });
  Object.assign(globalThis.shuzhirenChannelStore.connections.get("channel_demo"), { lastVerifiedAt: new Date().toISOString(), verifiedBy: "variant-test" });
  const rules = await import("../apps/console/lib/interaction-rules.ts");
  const admin = { ...operator, actorId: "variant-admin", actorName: "Variant Admin", role: "admin" };
  const reviewer = { ...operator, actorId: "variant-reviewer", actorName: "Variant Reviewer", role: "reviewer" };
  const created = await rules.createDefaultInteractionRules(admin);
  const disclosure = created.created.find((rule) => rule.defaultKey === "ai_disclosure");
  await rules.approveInteractionRule(reviewer, disclosure.id);

  // The second version contains a built-in block term (最低价); the third is clean.
  const runId = await demoRunWith("ARMED", fixedProgram(["全网最低价，欢迎选购", "变体二话术"]), undefined);
  const started = chosen(await dispatch(runId, "START", "ARMED"));
  assert.deepEqual(started, { index: "0", script: "主版本话术", segment: segmentIds.first });
  await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.second);
  const rollback = await dispatch(runId, "ROLLBACK_PROGRAM", "LIVE");
  // After version 0 comes version 1, which is refused; version 2 is chosen and version 1 is recorded as skipped.
  assert.deepEqual(chosen(rollback), { index: "2", script: "变体二话术", segment: segmentIds.first });
  assert.equal(rollback.mediaEvent.command.payload.scriptSha256, sha256Hex("变体二话术"));
  const [latest] = await listScriptPlays(operator, runId);
  assert.deepEqual([latest.variantIndex, latest.variantCount, latest.skippedVariantIndexes, latest.playSeq, latest.controlAction], [2, 3, [1], 2, "ROLLBACK_PROGRAM"]);
  const selected = globalThis.shuzhirenAuditStore.events.find((event) => event.type === "program_script.variant_selected" && event.detail.outboxEventId === latest.outboxEventId);
  assert.equal(selected.detail.skippedVariantIndexes, "1");
});

test("when every version of a segment is blocked the command is refused and nothing is written", async () => {
  const runId = await demoRunWith("LIVE", [
    runnable(segmentIds.first, 1, "prepared_product", "主版本话术"),
    runnable(segmentIds.second, 2, "interactive", "全网最低价", ["最佳产品", "治疗效果"]),
    ...fallbackSegments
  ], segmentIds.first);
  const outbox = globalThis.shuzhirenOutboxStore?.events.size ?? 0;
  const run = globalThis.shuzhirenControlStore.runs.get(runId);
  await assert.rejects(dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.second), (error) => error instanceof Response && error.status === 409 && error.statusText === "program_script_policy_blocked");
  assert.equal(run.commandHistory.length, 0);
  assert.equal(run.activeInsertProgramSegmentId, undefined);
  assert.equal(globalThis.shuzhirenOutboxStore?.events.size ?? 0, outbox);
  assert.deepEqual(await listScriptPlays(operator, runId), []);
});

test("GET script-plays serves the ledger to the four read roles and refuses the others", async () => {
  const runId = await demoRunWith("LIVE", fixedProgram(["变体一话术"]), segmentIds.second);
  await dispatch(runId, "INSERT_PROGRAM", "LIVE", segmentIds.first);
  const saved = { identity: process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY, hostname: process.env.HOSTNAME };
  process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";
  process.env.HOSTNAME = "127.0.0.1";
  try {
    const call = (role, id = runId, tenantId = operator.tenantId) => scriptPlaysRoute(
      new Request(`http://console.test/api/v1/live-runs/${id}/script-plays`, { headers: { "x-tenant-id": tenantId, "x-actor-id": "route-test", "x-actor-name": "Route Test", "x-actor-role": role } }),
      { params: Promise.resolve({ runId: id }) }
    );
    for (const role of ["admin", "operator", "reviewer", "analyst"]) {
      const response = await call(role);
      assert.equal(response.status, 200, role);
      const { data } = await response.json();
      assert.equal(data.length, 1);
      assert.deepEqual([data[0].variantIndex, data[0].variantCount, data[0].playSeq, data[0].controlAction], [0, 2, 1, "INSERT_PROGRAM"]);
      assert.ok(!JSON.stringify(data).includes("话术"), "the ledger never carries script text");
    }
    assert.equal((await call("viewer")).status, 403);
    assert.equal((await call("operator", "not-a-run")).status, 404);
    assert.deepEqual((await (await call("operator", runId, "tenant_other")).json()).data, [], "another tenant sees no ledger rows");
  } finally {
    for (const [key, value] of [["CONTROL_PLANE_DEV_HEADER_IDENTITY", saved.identity], ["HOSTNAME", saved.hostname]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
