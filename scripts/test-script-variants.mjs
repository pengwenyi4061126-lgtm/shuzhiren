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
