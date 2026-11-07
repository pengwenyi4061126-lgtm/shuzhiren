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
// ---- Worker: scheduled start picks a script version (task 7.9; design.md C.3, C.6) ----
// The code under test is the real scheduleDueRun of apps/runtime-worker/index.mjs. That file is a long-running
// entry point (it connects and loops when imported), so its text from the version-selection helpers up to
// meterLiveUsage is evaluated here with a fake pg client and fake tenant transaction instead.
const workerSourceText = (await (await import("node:fs/promises")).readFile(new URL("../apps/runtime-worker/index.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const workerPolicyEngine = await import("../apps/console/lib/shared/policy-engine.mjs");
const workerGuard = await import("../apps/console/lib/shared/broadcast-guard.mjs");
const workerBuiltin = await import("../apps/console/lib/shared/prohibited-terms-builtin.mjs");
const workerLexicon = await import("../apps/console/lib/shared/prohibited-terms.mjs");
const workerRotation = await import("../apps/console/lib/shared/script-rotation.mjs");
function sliceWorker(startMarker, endMarker) {
  const start = workerSourceText.indexOf(startMarker);
  const end = workerSourceText.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `worker source must contain ${startMarker} before ${endMarker}`);
  return workerSourceText.slice(start, end);
}
const workerPieces = [
  sliceWorker("function tenantOrder(", "function inTenantTransaction("),
  sliceWorker("// ---- Script version selection for scheduled starts", "async function meterLiveUsage()"),
  workerSourceText.match(/^function runtimeVoiceIdValid.*$/m)[0],
  workerSourceText.match(/^function voiceChecksumValid.*$/m)[0]
].join("\n");
const buildScheduleDueRun = (deps) => new Function("deps", `const { tenantIds, inTenantTransaction, createHash, guardBroadcastText, parsePolicyRules, BUILTIN_LEXICON, effectiveLexicon, compileLexicon, runtimeLexicon, chooseScriptVariant, scriptVariantsProblem } = deps;
let nextSchedulerTenantCursor = 0;
${workerPieces}
return scheduleDueRun;`)(deps);
const workerTenant = "10000000-0000-4000-8000-000000000001";
const workerRun = { id: "10000000-0000-4000-8000-0000000000a1", tenant_id: workerTenant, show_revision_id: "10000000-0000-4000-8000-0000000000b1", trace_id: "trace-1", runtime_session_id: "session-1" };
const workerSegment = { id: "10000000-0000-4000-8000-0000000000c1", runtime_script: "主版本话术", runtime_script_variants: ["变体一话术", "变体二话术"] };
const workerProfile = { rules: [{ id: "r1", terms: ["违规词"], reason: "测试拦截", action: "refuse", riskLevel: "high", requiredEvidence: [] }], evidence_ref: "evidence://probe/policy", validation_summary: "ok", approval_status: "approved" };
const workerVoice = { runtime_voice_id: "voice_1", checksum: `sha256:${"a".repeat(64)}` };
// Runs scheduleDueRun once against a fake client; `state` selects what the reads return. Every statement is logged with its transaction.
async function runWorkerSchedule({ segment = workerSegment, last = null, profile = workerProfile, voice = workerVoice, terms = [], snapshot = null, failOn = null } = {}) {
  const log = [];
  let transactions = 0;
  const client = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, " ").trim();
      log.push({ sql, params, tx: transactions });
      if (failOn && failOn.test(sql)) throw new Error("injected failure");
      if (/from live_runs where state = 'ARMED'/.test(sql)) return { rows: [workerRun] };
      if (sql.startsWith("select id, runtime_script, runtime_script_variants from show_revision_segments")) return { rows: segment ? [segment] : [] };
      if (sql.includes("from show_revision_media_assets binding")) return { rows: voice ? [voice] : [] };
      if (sql.includes("from tenant_entitlements")) return { rows: [] };
      if (sql.startsWith("update runtime_alerts")) return { rows: [] };
      if (sql.includes("from show_revision_policy_profiles binding")) return { rows: profile ? [profile] : [] };
      if (sql.startsWith("select lexicon from show_revision_prohibited_term_snapshots")) return { rows: snapshot === null ? [] : [{ lexicon: snapshot }] };
      if (sql.startsWith("select tenant_id, kind, builtin_term_id, term, normalized_term, category, approved_revision")) return { rows: terms };
      if (sql.startsWith("select variant_index, play_seq from live_run_script_plays")) return { rows: last ? [last] : [] };
      if (sql.startsWith("insert into outbox_events")) return { rows: [{ id: "10000000-0000-4000-8000-0000000000e1" }] };
      if (sql.startsWith("insert into runtime_alerts")) return { rows: [{ id: "alert-1" }] };
      if (sql.includes("runtime_worker_actor")) return { rows: [{ id: "actor-1" }] };
      if (/^(update live_runs|insert into live_run_script_plays|insert into audit_events)/.test(sql)) return { rows: [] };
      throw new Error(`unexpected worker query: ${sql}`);
    }
  };
  const scheduleDueRun = buildScheduleDueRun({
    tenantIds: async () => [workerTenant],
    inTenantTransaction: async (tenantId, operation) => {
      assert.equal(tenantId, workerTenant);
      transactions += 1;
      log.push({ sql: "begin", params: [], tx: transactions });
      try { const value = await operation(client); log.push({ sql: "commit", params: [], tx: transactions }); return value; } catch (error) { log.push({ sql: "rollback", params: [], tx: transactions }); throw error; }
    },
    createHash,
    guardBroadcastText: workerGuard.guardBroadcastText,
    parsePolicyRules: workerPolicyEngine.parsePolicyRules,
    BUILTIN_LEXICON: workerBuiltin.BUILTIN_LEXICON,
    effectiveLexicon: workerLexicon.effectiveLexicon,
    compileLexicon: workerLexicon.compileLexicon,
    runtimeLexicon: workerLexicon.runtimeLexicon,
    chooseScriptVariant: workerRotation.chooseScriptVariant,
    scriptVariantsProblem: workerRotation.scriptVariantsProblem
  });
  const result = await scheduleDueRun();
  const find = (prefix) => log.filter((entry) => entry.sql.startsWith(prefix));
  const outbox = find("insert into outbox_events")[0] ?? null;
  return { result, log, find, outbox, command: outbox ? JSON.parse(outbox.params[2]).command : null };
}
const hashOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
test("worker scheduled start selects version 0 on the first play and records the ledger row with the outbox event", async () => {
  const { result, find, outbox, command, log } = await runWorkerSchedule();
  assert.deepEqual(result, { runId: workerRun.id, eventId: "10000000-0000-4000-8000-0000000000e1" });
  assert.equal(command.payload.controlAction, "SCHEDULED_START");
  assert.equal(command.payload.runtimeScript, "主版本话术");
  assert.equal(command.payload.scriptSha256, hashOf("主版本话术"));
  assert.equal(command.payload.scriptVariantIndex, "0");
  const ledger = find("insert into live_run_script_plays")[0];
  // $1 tenant, $2 run, $3 revision, $4 segment, $5 play_seq, $6 variant_index, $7 variant_count, $8 sha, $9 outbox event, $10 skipped
  assert.deepEqual(ledger.params, [workerTenant, workerRun.id, workerRun.show_revision_id, workerSegment.id, 1, 0, 3, hashOf("主版本话术"), "10000000-0000-4000-8000-0000000000e1", []]);
  assert.match(ledger.sql, /'SCHEDULED_START'/);
  assert.equal(ledger.tx, outbox.tx, "the ledger insert and the outbox insert share one transaction");
  assert.ok(log.indexOf(ledger) > log.indexOf(outbox), "the ledger row is written after the outbox event it references");
  assert.equal(log.at(-1).sql, "commit");
  const audit = find("insert into audit_events").find((entry) => entry.sql.includes("program_script.variant_selected"));
  assert.ok(audit && audit.tx === outbox.tx);
  assert.deepEqual(JSON.parse(audit.params[3]), { segmentId: workerSegment.id, variantIndex: 0, variantCount: 3, scriptSha256: hashOf("主版本话术"), playSeq: 1, outboxEventId: "10000000-0000-4000-8000-0000000000e1", skippedVariantIndexes: "", controlAction: "SCHEDULED_START" });
  assert.equal(find("insert into runtime_alerts").length, 0);
});
test("worker scheduled start continues the rotation after the last ledger row", async () => {
  const second = await runWorkerSchedule({ last: { variant_index: 0, play_seq: 1 } });
  assert.deepEqual([second.command.payload.runtimeScript, second.command.payload.scriptVariantIndex], ["变体一话术", "1"]);
  assert.deepEqual(second.find("insert into live_run_script_plays")[0].params.slice(4, 8), [2, 1, 3, hashOf("变体一话术")]);
  const wrapped = await runWorkerSchedule({ last: { variant_index: 2, play_seq: 7 } });
  assert.deepEqual([wrapped.command.payload.scriptVariantIndex, wrapped.find("insert into live_run_script_plays")[0].params[4]], ["0", 8]);
});
test("worker scheduled start skips a refused version and records it", async () => {
  const segment = { ...workerSegment, runtime_script_variants: ["含违规词的话术", "变体二话术"] };
  const { command, find } = await runWorkerSchedule({ segment, last: { variant_index: 0, play_seq: 1 } });
  assert.equal(command.payload.scriptVariantIndex, "2");
  assert.deepEqual(find("insert into live_run_script_plays")[0].params[9], [1]);
  const audit = find("insert into audit_events").find((entry) => entry.sql.includes("program_script.variant_selected"));
  assert.equal(JSON.parse(audit.params[3]).skippedVariantIndexes, "1");
});
test("worker scheduled start checks approved current tenant terms", async () => {
  const term = { kind: "custom", term: "租户定时脚本禁词", normalized_term: "租户定时脚本禁词", category: "custom", approved_revision: 1, severity: "block", suggestions: [], disabled: false, active: true };
  const segment = { ...workerSegment, runtime_script: "租户定时脚本禁词", runtime_script_variants: ["合规替代话术"] };
  const { command, find } = await runWorkerSchedule({ segment, terms: [term] });
  assert.deepEqual([command.payload.runtimeScript, command.payload.scriptVariantIndex], ["合规替代话术", "1"]);
  assert.deepEqual(find("insert into live_run_script_plays")[0].params[9], [0]);
});
test("worker scheduled start retains a blocking term frozen in the revision after it is disabled", async () => {
  const term = { id: "custom:冻结定时脚本禁词", term: "冻结定时脚本禁词", normalized: "冻结定时脚本禁词", category: "custom", severity: "block", suggestions: [] };
  const disabledCurrentTerm = { kind: "custom", term: term.term, normalized_term: term.normalized, category: "custom", approved_revision: 2, severity: "block", suggestions: [], disabled: false, active: false };
  const segment = { ...workerSegment, runtime_script: term.term, runtime_script_variants: ["合规替代话术"] };
  const { command, find } = await runWorkerSchedule({ segment, terms: [disabledCurrentTerm], snapshot: [term] });
  assert.deepEqual([command.payload.runtimeScript, command.payload.scriptVariantIndex], ["合规替代话术", "1"]);
  assert.deepEqual(find("insert into live_run_script_plays")[0].params[9], [0]);
});
test("worker scheduled start with every version refused dispatches nothing and opens program_script_blocked", async () => {
  const segment = { id: workerSegment.id, runtime_script: "含违规词的主话术", runtime_script_variants: ["违规词变体"] };
  const { result, find, log } = await runWorkerSchedule({ segment });
  assert.equal(result, null);
  assert.equal(find("insert into outbox_events").length, 0, "no SCHEDULED_START outbox event");
  assert.equal(find("insert into live_run_script_plays").length, 0, "no ledger row");
  assert.ok(find("update live_runs set scheduled_at = null").length === 1, "the schedule is cleared");
  const alert = find("insert into runtime_alerts");
  assert.equal(alert.length, 1);
  assert.match(alert[0].sql, /'program_script_blocked'/);
  assert.deepEqual(alert[0].params, [workerTenant, workerRun.id]);
  assert.ok(find("insert into audit_events").some((entry) => entry.sql.includes("live_run.start_blocked_by_program_script_policy")));
  assert.equal(log.at(-1).sql, "commit");
});
test("worker scheduled start refuses when the revision has no approved policy profile", async () => {
  const { result, find } = await runWorkerSchedule({ profile: null });
  assert.equal(result, null);
  assert.equal(find("insert into outbox_events").length, 0);
  assert.match(find("insert into runtime_alerts")[0].sql, /'program_script_blocked'/);
});
test("worker scheduled start treats a malformed stored variant list like a missing script", async () => {
  const { result, find } = await runWorkerSchedule({ segment: { ...workerSegment, runtime_script_variants: ["主版本话术"] } });
  assert.equal(result, null);
  assert.equal(find("insert into outbox_events").length, 0);
  assert.match(find("insert into runtime_alerts")[0].sql, /'program_script_missing'/);
});
test("worker scheduled start rolls back when the ledger insert fails", async () => {
  await assert.rejects(runWorkerSchedule({ failOn: /^insert into live_run_script_plays/ }), /injected failure/);
});
test("the worker never forwards scriptVariantIndex to the Gateway and imports shared code only from console/lib/shared", () => {
  const request = sliceWorker("function deliveryRequest(", "\nfunction ");
  assert.ok(!request.includes("scriptVariantIndex"), "deliveryRequest must not send scriptVariantIndex");
  const sharedImports = [...workerSourceText.matchAll(/^import .* from "(\.\.\/console\/[^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(sharedImports.filter((specifier) => !/^\.\.\/console\/lib\/shared\/[a-z-]+\.mjs$/.test(specifier)), []);
  assert.ok(sharedImports.length >= 5);
});
// ---- Task 8.1 (demo mode): submission and approval check every script version and freeze the lexicon ----
// Demo-mode lifecycle goes through updateDemoProgramLifecycle (what advanceRunLifecycle calls in demo mode). The script check is
// the same pure function the PostgreSQL path uses, so the 422 body is read from the thrown Response.
const { updateDemoProgramLifecycle } = await import("../apps/console/lib/show-program.ts");
const demoTerms = await import("../apps/console/lib/prohibited-terms.ts");
const demoBuiltin = await import("../apps/console/lib/shared/prohibited-terms-builtin.mjs");
const demoLexiconModule = await import("../apps/console/lib/shared/prohibited-terms.mjs");
const { listAuditEvents } = await import("../apps/console/lib/audit.ts");
let approvalCounter = 0;
/** A draft demo program with one runnable segment (primary text and `variants`), a fallback and a human handoff. */
function draftDemoProgram(primary, variants) {
  approvalCounter += 1;
  const runId = `run_variant_approval_${approvalCounter}`;
  const revisionId = `show_revision_variant_approval_${approvalCounter}`;
  registerDemoProgram({
    runId, tenantId: operator.tenantId, revisionId, status: "draft", editable: true,
    segments: [
      runnable(segmentIds.first, 1, "prepared_product", primary, variants),
      { id: segmentIds.second, position: 2, kind: "fallback", title: "兜底", durationSeconds: 30, productVersionId: "pv_a102_v1", purpose: "兜底", fallback: true },
      { id: "20000000-0000-4000-8000-00000000000b", position: 3, kind: "human_handoff", title: "转人工", durationSeconds: 0, purpose: "转人工", fallback: true }
    ]
  });
  return { runId, revisionId, program: () => globalThis.shuzhirenProgramStore.programs.get(runId) };
}
const thrownResponse = (action) => {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Response, "a Response is thrown");
    return error;
  }
  assert.fail("expected a Response to be thrown");
};
test("demo submit_review refuses a blocked extra version with 422 and the position and version index, and leaves the program editable", async () => {
  const draft = draftDemoProgram("主版本话术", ["变体一话术", "全网最低价，欢迎选购"]);
  const response = thrownResponse(() => updateDemoProgramLifecycle(draft.runId, "submit_review"));
  assert.equal(response.status, 422);
  assert.equal(response.statusText, "program_script_policy_blocked");
  const body = await response.json();
  assert.equal(body.error, "program_script_policy_blocked");
  assert.equal(body.failures.length, 1);
  const [failure] = body.failures;
  assert.deepEqual([failure.position, failure.variantIndex, failure.text], [1, 2, "全网最低价，欢迎选购"]);
  assert.ok(failure.reasons.some((reason) => reason.startsWith("lexicon:extreme:")));
  assert.ok(failure.findings.length >= 1 && failure.findings.every((finding) => finding.severity === "block"));
  assert.equal(draft.program().editable, true, "the program is not locked after a refused submission");
});
test("demo approval checks the primary script too (Q3) and freezes nothing when it is refused", async () => {
  const draft = draftDemoProgram("这款产品治疗皮肤问题", []);
  const response = thrownResponse(() => updateDemoProgramLifecycle(draft.runId, "approve"));
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).failures.map((failure) => [failure.position, failure.variantIndex]), [[1, 0]]);
  assert.equal(draft.program().status, "draft");
  assert.equal(demoTerms.demoLexiconSnapshot(draft.revisionId), null);
});
test("demo approval of a clean program writes the lexicon snapshot and approves the program", () => {
  const draft = draftDemoProgram("主版本话术", ["变体一话术"]);
  updateDemoProgramLifecycle(draft.runId, "submit_review");
  assert.equal(draft.program().editable, false);
  updateDemoProgramLifecycle(draft.runId, "approve");
  assert.equal(draft.program().status, "approved");
  const snapshot = demoTerms.demoLexiconSnapshot(draft.revisionId);
  const current = demoTerms.currentDemoLexicon(operator.tenantId);
  assert.equal(snapshot.builtinVersion, demoBuiltin.BUILTIN_LEXICON_VERSION);
  assert.equal(snapshot.termCount, current.length);
  assert.equal(snapshot.lexiconSha256, demoLexiconModule.lexiconSha256(current));
  assert.ok(snapshot.termCount > 0);
  // Approving again keeps the first snapshot: a revision is frozen once.
  updateDemoProgramLifecycle(draft.runId, "approve");
  assert.deepEqual(demoTerms.demoLexiconSnapshot(draft.revisionId), snapshot);
});
test("demo run lexicon is the snapshot united with the current lexicon, and a revision without a snapshot uses the current one", () => {
  const draft = draftDemoProgram("主版本话术", []);
  updateDemoProgramLifecycle(draft.runId, "approve");
  const runLexicon = demoTerms.demoRunLexicon(operator.tenantId, draft.revisionId);
  assert.deepEqual(runLexicon.map((term) => term.id), demoTerms.currentDemoLexicon(operator.tenantId).map((term) => term.id));
  assert.deepEqual(demoTerms.demoRunLexicon(operator.tenantId, "show_revision_without_snapshot").map((term) => term.id), runLexicon.map((term) => term.id));
  assert.equal(demoTerms.demoRunLexicon("tenant_other", draft.revisionId).length, demoTerms.currentDemoLexicon("tenant_other").length, "another tenant's snapshot is never read");
});
// The lifecycle route returns the 422 answer as it is, so the caller sees which position and version was refused and why (Requirement 3.4).
const { POST: lifecycleRoute } = await import("../apps/console/app/api/v1/live-runs/[runId]/lifecycle/route.ts");
test("lifecycle route submit_review forwards the refused-script failures instead of only the error code", async () => {
  const runId = await demoRunWith("DRAFT", fixedProgram([]), segmentIds.first);
  const run = globalThis.shuzhirenControlStore.runs.get(runId);
  const segments = [
    runnable(segmentIds.first, 1, "prepared_product", "主版本话术", ["变体一话术", "全网最低价，欢迎选购"]),
    { id: segmentIds.second, position: 2, kind: "fallback", title: "兜底", durationSeconds: 30, productVersionId: "pv_a102_v1", purpose: "兜底", fallback: true },
    { id: "20000000-0000-4000-8000-00000000000b", position: 3, kind: "human_handoff", title: "转人工", durationSeconds: 0, purpose: "转人工", fallback: true }
  ];
  registerDemoProgram({ runId, tenantId: operator.tenantId, revisionId: run.revisionId, status: "draft", editable: true, segments });
  const saved = { identity: process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY, hostname: process.env.HOSTNAME };
  process.env.CONTROL_PLANE_DEV_HEADER_IDENTITY = "true";
  process.env.HOSTNAME = "127.0.0.1";
  let response;
  try {
    response = await lifecycleRoute(
      new Request(`http://console.test/api/v1/live-runs/${runId}/lifecycle`, { method: "POST", headers: { "x-tenant-id": operator.tenantId, "x-actor-id": "route-test", "x-actor-name": "Route Test", "x-actor-role": "operator", "content-type": "application/json" }, body: JSON.stringify({ action: "submit_review" }) }),
      { params: Promise.resolve({ runId }) }
    );
  } finally {
    for (const [key, value] of [["CONTROL_PLANE_DEV_HEADER_IDENTITY", saved.identity], ["HOSTNAME", saved.hostname]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const body = await response.json();
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.error, "program_script_policy_blocked");
  assert.equal(body.failures.length, 1);
  assert.deepEqual([body.failures[0].position, body.failures[0].variantIndex, body.failures[0].text], [1, 2, "全网最低价，欢迎选购"]);
  assert.ok(body.failures[0].reasons.length >= 1);
  assert.equal(run.state, "DRAFT", "a refused submission does not advance the run");
  const auditEvents = await listAuditEvents({ ...operator, actorId: "audit-reviewer", actorName: "Audit Reviewer", role: "admin" });
  const [blockedEvent] = auditEvents.filter((event) => event.type === "show_program.script_policy_blocked" && event.resourceId === run.revisionId);
  assert.ok(blockedEvent, "the refused lifecycle action records a separate audit event");
  assert.deepEqual(blockedEvent.detail, { runId, failureCount: 1, failures: [{ position: 1, variantIndex: 2, textSha256: createHash("sha256").update("全网最低价，欢迎选购").digest("hex") }] });
  assert.ok(!JSON.stringify(blockedEvent.detail).includes("全网最低价，欢迎选购"));
});
