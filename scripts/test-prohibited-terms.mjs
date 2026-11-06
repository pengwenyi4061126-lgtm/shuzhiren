// Unit tests for the shared prohibited-term modules (design.md module E, E0):
// apps/console/lib/shared/{prohibited-terms,prohibited-terms-builtin,broadcast-guard}.mjs.
// Run: node --test scripts/test-prohibited-terms.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson } from "../apps/console/lib/canonical-json.mjs";
import { guardBroadcastText } from "../apps/console/lib/shared/broadcast-guard.mjs";
import { evaluatePolicy, normalizePolicyText } from "../apps/console/lib/shared/policy-engine.mjs";
import { BUILTIN_LEXICON, BUILTIN_LEXICON_VERSION } from "../apps/console/lib/shared/prohibited-terms-builtin.mjs";
import { applySuggestion, compileLexicon, effectiveLexicon, lexiconSha256, normalizeForScan, runtimeLexicon, scanProhibitedTerms, termProblem } from "../apps/console/lib/shared/prohibited-terms.mjs";

const term = (id, text, severity = "block", suggestions = [], category = "extreme") => ({ id, term: text, category, severity, suggestions });
const builtinLexicon = compileLexicon(BUILTIN_LEXICON);
const guardOptions = (lexicon, extra = {}) => ({ policyRules: [], lexicon, maxLength: 800, ...extra });

test("built-in lexicon: four categories of 15-30 terms, stable ids, example-only header", async () => {
  assert.match(BUILTIN_LEXICON_VERSION, /^.{1,40}$/);
  for (const category of ["extreme", "medical", "false_claim", "offsite_trade"]) {
    const entries = BUILTIN_LEXICON.filter((entry) => entry.category === category);
    assert.ok(entries.length >= 15 && entries.length <= 30, `${category} has ${entries.length} terms`);
    entries.forEach((entry, index) => assert.equal(entry.id, `builtin:${category}:${String(index + 1).padStart(3, "0")}`));
  }
  assert.equal(BUILTIN_LEXICON.length, BUILTIN_LEXICON.filter((entry) => entry.category !== "custom").length);
  assert.equal(new Set(BUILTIN_LEXICON.map((entry) => entry.id)).size, BUILTIN_LEXICON.length);
  assert.equal(builtinLexicon.length, BUILTIN_LEXICON.length, "no two built-in terms share a normalized form");
  for (const entry of BUILTIN_LEXICON) {
    assert.ok(["block", "warn"].includes(entry.severity), entry.id);
    assert.ok(entry.suggestions.length <= 5, entry.id);
    assert.equal(termProblem(entry.term), null, entry.id);
  }
  assert.equal(BUILTIN_LEXICON[0].id, "builtin:extreme:001");
  assert.equal(BUILTIN_LEXICON[0].term, "全网最低");
  assert.deepEqual([...BUILTIN_LEXICON[0].suggestions], ["活动价", "优惠价"]);
  const source = await readFile(new URL("../apps/console/lib/shared/prohibited-terms-builtin.mjs", import.meta.url), "utf8");
  assert.match(source.split("\n").slice(0, 4).join("\n"), /示例词表，未经法务审定/);
  assert.doesNotMatch(source, /已(?:经)?法务审定|法务已审定/);
});

test("no built-in replacement suggestion contains a blocking term", () => {
  for (const entry of BUILTIN_LEXICON) {
    for (const suggestion of entry.suggestions) {
      assert.deepEqual(scanProhibitedTerms(suggestion, builtinLexicon).filter((finding) => finding.severity === "block"), [], `${entry.id}: ${suggestion}`);
    }
  }
});

test("scanProhibitedTerms maps an obfuscated hit back to the original range and applySuggestion edits it", () => {
  const text = "今天全 网 最 低价！";
  const findings = scanProhibitedTerms(text, builtinLexicon);
  const first = findings[0];
  assert.equal(first.termId, "builtin:extreme:001");
  assert.deepEqual([first.start, first.end, first.matchedText, first.severity], [2, 9, "全 网 最 低", "block"]);
  assert.deepEqual(first.suggestions, ["活动价", "优惠价"]);
  assert.deepEqual(findings.map((finding) => finding.termId), ["builtin:extreme:001", "builtin:extreme:002"]);
  assert.equal(applySuggestion(text, first, "活动价"), "今天活动价价！");
  assert.throws(() => applySuggestion("别的文本", first, "活动价"), RangeError);
});

test("scanProhibitedTerms handles full-width, zero-width, upper-case and overlapping hits without mutating inputs", () => {
  const lexicon = compileLexicon([term("a", "vx"), term("b", "加微信"), term("c", "aa")]);
  const frozen = JSON.stringify(lexicon);
  const text = "ＶX 加\u200B微信 aaa";
  const findings = scanProhibitedTerms(text, lexicon);
  assert.deepEqual(findings.map((finding) => [finding.termId, finding.matchedText]), [["a", "ＶX"], ["b", "加\u200B微信"], ["c", "aa"], ["c", "aa"]]);
  for (const finding of findings) assert.equal(finding.matchedText, text.slice(finding.start, finding.end));
  assert.equal(JSON.stringify(lexicon), frozen);
  assert.deepEqual(scanProhibitedTerms("", lexicon), []);
  assert.deepEqual(scanProhibitedTerms("没有命中", lexicon), []);
});

test("scanProhibitedTerms covers the whole text when a hit cannot be mapped to a range", () => {
  // Hangul jamo compose across code points, so per-cluster normalization differs from whole-text normalization.
  const text = "\u1112\u1161\u11ab";
  assert.equal(normalizeForScan(text).exact, false);
  const lexicon = compileLexicon([term("h", "\ud55c")]);
  assert.equal(normalizePolicyText(text), "\ud55c");
  const findings = scanProhibitedTerms(text, lexicon);
  assert.deepEqual(findings.map((finding) => [finding.start, finding.end]), [[0, text.length]]);
});

test("compileLexicon normalizes, keeps the stricter severity per normalized term and sorts", () => {
  const lexicon = compileLexicon([
    term("z", "VX", "warn", ["改"]),
    term("y", "ｖｘ", "block", ["换"]),
    term("x", "v x", "block", ["早"]),
    term("w", "  ", "block"),
    { id: "", term: "空", category: "extreme", severity: "block" },
    term("a", "加微信", "warn")
  ]);
  assert.deepEqual(lexicon.map((entry) => [entry.id, entry.normalized, entry.severity, entry.suggestions]), [["x", "vx", "block", ["早"]], ["a", "加微信", "warn", []]]);
  assert.deepEqual(compileLexicon([...[term("z", "VX", "warn"), term("y", "ｖｘ"), term("x", "v x")]].reverse()), compileLexicon([term("z", "VX", "warn"), term("y", "ｖｘ"), term("x", "v x")]));
});

test("termProblem rejects empty, whitespace-only, zero-width-only and over-long terms", () => {
  assert.equal(termProblem("全网最低"), null);
  assert.equal(termProblem(" 加 微信 "), null);
  assert.equal(termProblem("a".repeat(30)), null);
  for (const bad of ["", "   ", "\u200B\u200C", "a".repeat(31), 42, null]) assert.equal(typeof termProblem(bad), "string", String(bad));
});

test("effectiveLexicon applies only approved disabling, suggestion overrides and custom terms", () => {
  const builtin = [term("builtin:extreme:001", "全网最低", "block", ["活动价"]), term("builtin:extreme:002", "顶级", "block", ["高品质"]), term("builtin:extreme:003", "第一", "warn", ["热门"])];
  const rows = [
    { kind: "builtin_override", builtin_term_id: "builtin:extreme:001", approved_revision: 2, disabled: true },
    { kind: "builtin_override", builtin_term_id: "builtin:extreme:002", approved_revision: 1, disabled: false, severity: "warn", suggestions: ["优质"] },
    { kind: "builtin_override", builtin_term_id: "builtin:extreme:003", approved_revision: null, disabled: true, severity: "block", suggestions: ["x"] },
    { kind: "custom", term: "神药", category: "custom", approved_revision: 1, severity: "block", suggestions: ["药品"], active: true },
    { kind: "custom", term: "待批", category: "custom", approved_revision: null, severity: "block", suggestions: [], active: true },
    { kind: "custom", term: "已下线", category: "custom", approved_revision: 3, severity: "block", suggestions: [], active: false },
    { kind: "custom", term: "  ", category: "custom", approved_revision: 1, severity: "block", suggestions: [], active: true }
  ];
  const lexicon = effectiveLexicon(builtin, rows);
  const summary = lexicon.map((entry) => [entry.id, entry.severity, entry.suggestions]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(summary, [
    ["builtin:extreme:002", "warn", ["优质"]],
    ["builtin:extreme:003", "warn", ["热门"]],
    [`custom:${normalizePolicyText("神药")}`, "block", ["药品"]]
  ]);
  assert.equal(effectiveLexicon(builtin, []).length, 3, "no tenant rows leaves the built-in terms");
});

test("runtimeLexicon unions snapshot and current: stricter severity, frozen suggestions, frozen null equals current", () => {
  const frozen = compileLexicon([term("f1", "全网最低", "block", ["活动价"]), term("f2", "顶级", "warn", ["高品质"])]);
  const current = compileLexicon([term("c2", "顶级", "block", ["优质"]), term("c3", "新词", "block")]);
  const merged = runtimeLexicon(frozen, current);
  assert.deepEqual(merged.map((entry) => [entry.normalized, entry.severity, entry.suggestions]).sort(), [["全网最低", "block", ["活动价"]], ["新词", "block", []], ["顶级", "block", ["高品质"]]].sort());
  assert.deepEqual(runtimeLexicon(null, current), current);
  // A term disabled after approval is still blocked for the revision that froze it.
  assert.equal(scanProhibitedTerms("全网最低", runtimeLexicon(frozen, [])).length, 1);
});

test("lexiconSha256 equals sha256 of canonicalJson and ignores input order", () => {
  const lexicon = compileLexicon([...BUILTIN_LEXICON, term("custom:神药", "神药", "block", ["药品"], "custom")]);
  const expected = createHash("sha256").update(canonicalJson(lexicon), "utf8").digest("hex");
  assert.equal(lexiconSha256(lexicon), expected);
  assert.equal(lexiconSha256([...lexicon].reverse()), expected);
  assert.match(lexiconSha256([]), /^[0-9a-f]{64}$/);
  assert.equal(lexiconSha256([]), createHash("sha256").update(canonicalJson([]), "utf8").digest("hex"));
  assert.notEqual(lexiconSha256(lexicon.slice(1)), expected);
});

test("guardBroadcastText: empty, too long, policy decision other than answer, and warn-only text", () => {
  const lexicon = compileLexicon([term("b", "加微信"), term("w", "第一", "warn", ["热门"])]);
  const ok = guardBroadcastText("欢迎来到直播间", guardOptions(lexicon));
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.findings, []);

  for (const blank of ["", "   ", "\n\t"]) {
    const result = guardBroadcastText(blank, guardOptions(lexicon));
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes("话术为空"));
  }

  const tooLong = guardBroadcastText("好".repeat(801), guardOptions(lexicon));
  assert.equal(tooLong.allowed, false);
  assert.ok(tooLong.reasons.some((reason) => reason.includes("800")));
  assert.equal(guardBroadcastText("好".repeat(10), guardOptions(lexicon, { maxLength: 10 })).allowed, true);
  assert.equal(guardBroadcastText("好".repeat(11), guardOptions(lexicon, { maxLength: 10 })).allowed, false);

  const handoff = guardBroadcastText("现在改价到一元", guardOptions(lexicon));
  assert.equal(handoff.allowed, false);
  assert.equal(handoff.decision.action, evaluatePolicy("现在改价到一元", ["product_version"], []).action);
  assert.notEqual(handoff.decision.action, "answer");
  assert.ok(handoff.reasons.includes("价格或库存修改请求"));

  const blocked = guardBroadcastText("欢迎加 微信", guardOptions(lexicon));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.findings[0].matchedText, "加 微信");
  assert.ok(blocked.reasons.includes("lexicon:extreme:b"));

  const warnOnly = guardBroadcastText("我们是第一次直播", guardOptions(lexicon));
  assert.equal(warnOnly.allowed, true);
  assert.equal(warnOnly.findings.length, 1);
  assert.equal(warnOnly.findings[0].severity, "warn");
  assert.deepEqual(warnOnly.reasons, []);

  assert.throws(() => guardBroadcastText("你好", guardOptions(lexicon, { maxLength: 0 })), RangeError);
});

test("guardBroadcastText uses the supplied evidence and policy rules", () => {
  const rules = [{ id: "r", terms: ["包邮"], reason: "运费说明", action: "answer", riskLevel: "medium", requiredEvidence: ["shipping_policy"] }];
  const without = guardBroadcastText("全场包邮", guardOptions([], { policyRules: rules }));
  assert.equal(without.allowed, false, "evidence defaults to product_version only");
  assert.ok(without.reasons.includes("缺少必要证据"));
  assert.equal(guardBroadcastText("全场包邮", guardOptions([], { policyRules: rules, evidenceIds: ["product_version", "shipping_policy"] })).allowed, true);
  const blockedByBuiltin = guardBroadcastText("今天全 网 最 低价！", guardOptions(builtinLexicon));
  assert.equal(blockedByBuiltin.allowed, false);
  assert.ok(blockedByBuiltin.reasons.includes("lexicon:extreme:builtin:extreme:001"));
});
