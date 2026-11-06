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
