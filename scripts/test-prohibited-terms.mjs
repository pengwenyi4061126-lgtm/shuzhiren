// Unit tests for the shared prohibited-term modules (design.md module E, E0):
// apps/console/lib/shared/{prohibited-terms,prohibited-terms-builtin,broadcast-guard}.mjs.
// Run: node --test scripts/test-prohibited-terms.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import fc from "fast-check";
import { canonicalJson } from "../apps/console/lib/canonical-json.mjs";
import { guardBroadcastText } from "../apps/console/lib/shared/broadcast-guard.mjs";
import { evaluatePolicy, normalizePolicyText } from "../apps/console/lib/shared/policy-engine.mjs";
import { BUILTIN_LEXICON, BUILTIN_LEXICON_VERSION } from "../apps/console/lib/shared/prohibited-terms-builtin.mjs";
import { applySuggestion, compileLexicon, effectiveLexicon, lexiconSha256, normalizeForScan, runtimeLexicon, scanProhibitedTerms, termProblem } from "../apps/console/lib/shared/prohibited-terms.mjs";

register("./lib/console-ts-loader.mjs", import.meta.url);
for (const name of ["DATABASE_URL", "CONTROL_PLANE_DEMO_MODE"]) delete process.env[name];
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
const termService = await import("../apps/console/lib/prohibited-terms.ts");
const termRoutes = {
  list: await import("../apps/console/app/api/v1/prohibited-terms/route.ts"),
  item: await import("../apps/console/app/api/v1/prohibited-terms/[termId]/route.ts"),
  approve: await import("../apps/console/app/api/v1/prohibited-terms/[termId]/approve/route.ts"),
  override: await import("../apps/console/app/api/v1/prohibited-terms/builtin/[builtinTermId]/override/route.ts"),
  scan: await import("../apps/console/app/api/v1/prohibited-terms/scan/route.ts")
};
const termHeaders = (role = "admin", actorId = `term-test-${role}`) => ({ "x-tenant-id": "tenant_prohibited_terms_api_test", "x-actor-id": actorId, "x-actor-name": "Prohibited Terms Test", "x-actor-role": role, "content-type": "application/json" });
const callTermRoute = async (handler, url, { method = "GET", body, role = "admin", actorId, params = {} } = {}) => {
  const response = await handler(new Request(`http://127.0.0.1${url}`, { method, headers: termHeaders(role, actorId), body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
};

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

test("tenant prohibited-term routes enforce governance, second approval and scan access", async () => {
  assert.equal((await callTermRoute(termRoutes.list.GET, "/api/v1/prohibited-terms", { role: "analyst" })).status, 200);
  assert.equal((await callTermRoute(termRoutes.list.POST, "/api/v1/prohibited-terms", { method: "POST", role: "operator", body: { term: "角色测试词" } })).status, 403);
  const auditCount = globalThis.shuzhirenAuditStore?.events.length ?? 0;
  assert.equal((await callTermRoute(termRoutes.scan.POST, "/api/v1/prohibited-terms/scan", { method: "POST", role: "analyst", body: { text: "全 网 最 低", context: "script" } })).status, 200);
  assert.equal(globalThis.shuzhirenAuditStore?.events.length ?? 0, auditCount, "high-frequency scans do not write audit events");
  assert.equal((await callTermRoute(termRoutes.scan.POST, "/api/v1/prohibited-terms/scan", { method: "POST", body: { text: "x".repeat(2001), context: "script" } })).status, 422);

  const created = await callTermRoute(termRoutes.list.POST, "/api/v1/prohibited-terms", { method: "POST", body: { term: "专属审批测试词", suggestions: ["日常用语"] }, actorId: "term-author" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.revisions[0].status, "pending");
  assert.equal(termService.currentDemoLexicon("tenant_prohibited_terms_api_test").some((entry) => entry.normalized === "专属审批测试词"), false);
  assert.equal((await callTermRoute(termRoutes.approve.POST, "/approve", { method: "POST", params: { termId: id }, actorId: "term-author" })).status, 200);

  assert.equal((await callTermRoute(termRoutes.override.PUT, "/override", { method: "PUT", params: { builtinTermId: "builtin:extreme:001" }, body: { disabled: true, reason: "太短" } })).status, 400);
  assert.equal((await callTermRoute(termRoutes.item.DELETE, "/term", { method: "DELETE", params: { termId: id }, body: { reason: "太短" } })).status, 400);
  const requested = await callTermRoute(termRoutes.item.PUT, "/term", { method: "PUT", params: { termId: id }, body: { severity: "warn", reason: "由管理员申请降低拦截级别" }, actorId: "term-author" });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const selfApproval = await callTermRoute(termRoutes.approve.POST, "/approve", { method: "POST", params: { termId: id }, actorId: "term-author" });
  assert.equal(selfApproval.status, 409);
  assert.equal(selfApproval.body.error, "prohibited_term_second_approver_required");
  assert.equal((await callTermRoute(termRoutes.approve.POST, "/approve", { method: "POST", role: "reviewer", params: { termId: id }, actorId: "term-reviewer" })).status, 200);

  const restricted = { tenantId: "tenant_prohibited_terms_restricted", actorId: "restricted-operator", actorName: "Restricted", role: "operator", accessScope: "restricted" };
  assert.equal((await termService.scanProhibitedTermText(restricted, "普通文本")).findings.length, 0);
  await assert.rejects(termService.listProhibitedTerms(restricted), (error) => error instanceof Response && error.status === 403);
});

test("Property 18: saved suggestions never contain a currently blocking term", async () => {
  let sequence = 0;
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 8 }), fc.boolean(), async (surrounding, insertBlockTerm) => {
    const suggestion = insertBlockTerm ? `可用${surrounding}全 网 最 低替代` : `可用${surrounding}替代`;
    const containsBlockTerm = scanProhibitedTerms(suggestion, builtinLexicon).some((finding) => finding.severity === "block");
    const rowCountBefore = globalThis.shuzhirenProhibitedTermStore?.rows.get("tenant_prohibited_terms_api_test")?.length ?? 0;
    const revisionCountBefore = globalThis.shuzhirenProhibitedTermStore?.revisions.get("tenant_prohibited_terms_api_test")?.length ?? 0;
    const result = await callTermRoute(termRoutes.list.POST, "/api/v1/prohibited-terms", { method: "POST", body: { term: `属性测试自定义词${sequence++}`, suggestions: [suggestion] }, actorId: "property-author" });
    assert.equal(result.status, containsBlockTerm ? 422 : 201, JSON.stringify({ suggestion, containsBlockTerm, result }));
    if (containsBlockTerm) {
      assert.equal(result.body.error, "prohibited_term_suggestion_blocked");
      assert.equal(globalThis.shuzhirenProhibitedTermStore.rows.get("tenant_prohibited_terms_api_test").length, rowCountBefore);
      assert.equal(globalThis.shuzhirenProhibitedTermStore.revisions.get("tenant_prohibited_terms_api_test").length, revisionCountBefore);
    }
  }), { numRuns: 100, seed: 180055 });
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

// Feature: live-commerce-p1-features, Property 15: 扫描结果映射回原文
// Validates: Requirements 5.8
// Texts of up to 2000 UTF-16 units built from whitespace, zero-width characters, full-width letters, combining marks,
// Hangul jamo (which compose across code points), context-sensitive and expanding characters, and astral code points.
// A finding that cannot be mapped to a narrower range covers the whole text, which still satisfies every assertion.
const property15Pool = [
  "a", "B", "v", "x", "V", "X", " ", " ", "\t", "\n", "\u3000", "\u200B", "\u200C", "\u200D", "\uFEFF", "\u2060",
  "Ｖ", "ｘ", "Ａ", "ａ", "１", "全", "网", "最", "低", "加", "微", "信", "\u0301", "\u0323", "\u0308",
  "\u1112", "\u1161", "\u11ab", "İ", "Σ", "ς", "ﬁ", "㈱", "Å", "\u212B", "😀", "𝐀", "。", "！"
];
const property15Char = fc.constantFrom(...property15Pool);
const property15Text = fc.oneof(
  { weight: 8, arbitrary: fc.array(property15Char, { maxLength: 1000 }).map((parts) => parts.join("")) },
  { weight: 1, arbitrary: fc.string({ maxLength: 200, unit: "binary" }) }
);
const property15RandomTerm = fc.oneof(
  fc.array(property15Char, { minLength: 1, maxLength: 5 }).map((parts) => parts.join("")),
  fc.string({ minLength: 1, maxLength: 6, unit: "binary" })
);
const property15Case = fc
  .tuple(
    property15Text,
    fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })), { maxLength: 4 }),
    fc.array(property15RandomTerm, { maxLength: 4 }),
    fc.array(fc.tuple(fc.constantFrom("extreme", "medical", "false_claim", "offsite_trade", "custom"), fc.constantFrom("block", "warn")), { minLength: 8, maxLength: 8 })
  )
  .map(([text, picks, randomTerms, flavors]) => {
    const derived = picks.map(([from, to]) => {
      const a = Math.floor(Math.min(from, to) * text.length);
      return text.slice(a, Math.min(Math.max(a, Math.floor(Math.max(from, to) * text.length)), a + 8));
    });
    const lexicon = [...derived, ...randomTerms]
      .map((raw) => ({ raw, normalized: normalizePolicyText(raw) }))
      .filter((entry) => entry.normalized !== "")
      .map((entry, index) => ({ id: `t${index}`, term: entry.raw, normalized: entry.normalized, category: flavors[index % flavors.length][0], severity: flavors[index % flavors.length][1], suggestions: [] }));
    return { text, lexicon };
  });

test("Property 15: every finding maps back to the original text, is ordered, and inputs are not modified", () => {
  let totalFindings = 0;
  let wholeTextFindings = 0;
  fc.assert(
    fc.property(property15Case, ({ text, lexicon }) => {
      assert.ok(text.length <= 2000);
      const textBefore = text;
      const lexiconBefore = JSON.stringify(lexicon);
      for (const entry of lexicon) Object.freeze(entry);
      Object.freeze(lexicon);
      const findings = scanProhibitedTerms(text, lexicon);
      const byId = new Map(lexicon.map((entry) => [entry.id, entry]));
      for (const finding of findings) {
        const entry = byId.get(finding.termId);
        assert.ok(entry, `unknown termId ${finding.termId}`);
        assert.ok(Number.isInteger(finding.start) && Number.isInteger(finding.end));
        assert.ok(0 <= finding.start && finding.start < finding.end && finding.end <= text.length, `range [${finding.start}, ${finding.end}) of ${text.length}`);
        assert.equal(finding.matchedText, text.slice(finding.start, finding.end));
        assert.ok(normalizePolicyText(finding.matchedText).includes(entry.normalized), `${JSON.stringify(finding.matchedText)} does not contain ${JSON.stringify(entry.normalized)}`);
        totalFindings += 1;
        if (finding.start === 0 && finding.end === text.length) wholeTextFindings += 1;
      }
      for (let index = 1; index < findings.length; index += 1) {
        const previous = findings[index - 1];
        const current = findings[index];
        const inOrder = previous.start < current.start || (previous.start === current.start && (previous.end > current.end || (previous.end === current.end && previous.termId <= current.termId)));
        assert.ok(inOrder, `findings ${index - 1} and ${index} are out of order`);
      }
      assert.equal(text, textBefore);
      assert.equal(JSON.stringify(lexicon), lexiconBefore);
    }),
    { numRuns: 1000, seed: 20250115 }
  );
  assert.ok(totalFindings >= 100, `the generators produced only ${totalFindings} findings`);
  assert.ok(wholeTextFindings < totalFindings, "some findings must map to a narrower range than the whole text");
});

// Feature: live-commerce-p1-features, Property 16: 拦截词不会漏拦
// Validates: Requirements 5.8, 5.9, 5.13
// A Block_Term is hidden inside random text in an obfuscated form (case changes, full-width letters, inserted
// whitespace and zero-width characters). Whenever normalizePolicyText(text) contains the term's normalized form,
// scanProhibitedTerms must return a finding for it and guardBroadcastText must refuse to broadcast the text and say why.
const property16Categories = ["extreme", "medical", "false_claim", "offsite_trade", "custom"];
const property16Separators = ["", "", "", " ", "  ", "\t", "\n", "\u3000", "\u200B", "\u200C", "\u200D", "\uFEFF", " \u200B "];
const builtinBlockTerms = BUILTIN_LEXICON.filter((entry) => entry.severity === "block").map((entry) => entry.term);
const property16Term = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...builtinBlockTerms, "vx", "加微信", "ABC", "Ab1") },
  { weight: 2, arbitrary: fc.array(property15Char, { minLength: 1, maxLength: 5 }).map((parts) => parts.join("")) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 6, unit: "grapheme-ascii" }) }
);
const toFullWidth = (char) => {
  const code = char.codePointAt(0);
  if (code === 0x20) return "\u3000";
  return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : char;
};
const obfuscateChar = (char, style) => (style === 1 ? char.toUpperCase() : style === 2 ? toFullWidth(char) : style === 3 ? toFullWidth(char.toUpperCase()) : char);
const property16Filler = fc.oneof(
  fc.array(property15Char, { maxLength: 300 }).map((parts) => parts.join("")),
  fc.string({ maxLength: 100, unit: "binary" }),
  fc.constantFrom("", "今天", "欢迎来到直播间 ", "。！")
);
const property16Case = fc
  .tuple(
    fc.array(fc.tuple(property16Term, fc.constantFrom("block", "warn"), fc.constantFrom(...property16Categories)), { minLength: 1, maxLength: 6 }),
    fc.nat(),
    fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.constantFrom(...property16Separators)), { minLength: 60, maxLength: 60 }),
    property16Filler,
    property16Filler,
    fc.boolean()
  )
  .map(([rawTerms, pick, noise, before, after, withSecondHit]) => {
    const lexicon = rawTerms.map(([term, severity, category], index) => ({ id: `t${index}`, term, normalized: normalizePolicyText(term), category, severity: index === pick % rawTerms.length ? "block" : severity, suggestions: [] })).filter((entry) => entry.normalized !== "");
    if (lexicon.length === 0) return { lexicon, text: before + after };
    const target = lexicon[pick % lexicon.length];
    let cursor = 0;
    const hide = (term) => {
      const chars = [...term];
      let out = "";
      chars.forEach((char, index) => {
        const [style, separator] = noise[cursor % noise.length];
        cursor += 1;
        out += obfuscateChar(char, style) + (index < chars.length - 1 ? separator : "");
      });
      return out;
    };
    const second = withSecondHit ? hide(lexicon[(pick + 1) % lexicon.length].term) : "";
    const text = `${before}${hide(target.term)}${second}${after}`.slice(0, 2000);
    return { lexicon, text };
  });

test("Property 16: a block term whose normalized form occurs in the text is always found and always stops the broadcast", () => {
  let premiseHeld = 0;
  fc.assert(
    fc.property(property16Case, ({ lexicon, text }) => {
      fc.pre(lexicon.length > 0 && text.length <= 2000);
      const normalizedText = normalizePolicyText(text);
      const hits = lexicon.filter((entry) => entry.severity === "block" && normalizedText.includes(entry.normalized));
      fc.pre(hits.length > 0);
      premiseHeld += 1;
      const findings = scanProhibitedTerms(text, lexicon);
      const result = guardBroadcastText(text, { policyRules: [], lexicon, maxLength: 2000 });
      for (const entry of hits) {
        assert.ok(findings.some((finding) => finding.termId === entry.id && finding.severity === "block"), `no finding for ${entry.id} ${JSON.stringify(entry.term)} in ${JSON.stringify(text)}`);
        assert.ok(result.findings.some((finding) => finding.termId === entry.id), `the guard reports no finding for ${entry.id}`);
        assert.ok(result.reasons.includes(`lexicon:${entry.category}:${entry.id}`), `reasons lack lexicon:${entry.category}:${entry.id}`);
      }
      assert.equal(result.allowed, false);
    }),
    { numRuns: 1000, seed: 20250116 }
  );
  assert.ok(premiseHeld >= 100, `only ${premiseHeld} generated cases satisfied the premise`);
});

test("Property 16: the compiled built-in lexicon never lets an obfuscated block term through", () => {
  const blocks = builtinLexicon.filter((entry) => entry.severity === "block");
  assert.ok(blocks.length > 0);
  fc.assert(
    fc.property(
      fc.constantFrom(...blocks),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.constantFrom(...property16Separators)), { minLength: 30, maxLength: 30 }),
      property16Filler,
      property16Filler,
      (entry, noise, before, after) => {
        const chars = [...entry.term];
        const hidden = chars.map((char, index) => obfuscateChar(char, noise[index % noise.length][0]) + (index < chars.length - 1 ? noise[index % noise.length][1] : "")).join("");
        const text = `${before}${hidden}${after}`.slice(0, 2000);
        fc.pre(normalizePolicyText(text).includes(entry.normalized));
        assert.ok(scanProhibitedTerms(text, builtinLexicon).some((finding) => finding.termId === entry.id));
        const result = guardBroadcastText(text, { policyRules: [], lexicon: builtinLexicon, maxLength: 2000 });
        assert.equal(result.allowed, false);
        assert.ok(result.reasons.includes(`lexicon:${entry.category}:${entry.id}`));
      }
    ),
    { numRuns: 300, seed: 20250117 }
  );
});

// Feature: live-commerce-p1-features, Property 17: 运行时词表只会更严
// Validates: Requirements 5.7
// F (a frozen lexicon or null) and C (the current lexicon) are drawn from a small pool of spellings that normalize to the
// same term, so one normalized term often appears on both sides, or twice on one side, with different severities.
// runtimeLexicon(F, C) must keep every Block_Term of either side (as a block), lose no term, and with F = null equal compileLexicon(C).
const property17Spellings = ["vx", "VX", "ｖｘ", "v x", "全网最低", "全 网 最 低", "全\u200B网最低", "加微信", "加 微信", "第一", "顶级", "ABC", "ａｂｃ", "神药"];
const property17Term = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...property17Spellings) },
  { weight: 1, arbitrary: fc.array(property15Char, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("")) }
);
const property17Side = (prefix) =>
  fc
    .array(fc.tuple(property17Term, fc.constantFrom("block", "warn"), fc.constantFrom(...property16Categories), fc.array(fc.constantFrom("活动价", "优惠价", "热门", "优质"), { maxLength: 3 })), { maxLength: 8 })
    .map((entries) => entries.map(([term, severity, category, suggestions], index) => ({ id: `${prefix}${index}`, term, category, severity, suggestions })));
const blockSet = (entries) => new Set(entries.filter((entry) => entry.severity === "block").map((entry) => normalizePolicyText(entry.term)).filter((normalized) => normalized !== ""));
const normalizedSet = (entries) => new Set(entries.map((entry) => normalizePolicyText(entry.term)).filter((normalized) => normalized !== ""));

test("Property 17: runtimeLexicon keeps every Block_Term of the frozen and the current lexicon", () => {
  let nullFrozen = 0;
  let severityDisagreements = 0;
  let sharedTerms = 0;
  fc.assert(
    fc.property(fc.option(property17Side("f"), { nil: null, freq: 5 }), property17Side("c"), (frozen, current) => {
      const frozenBefore = JSON.stringify(frozen);
      const currentBefore = JSON.stringify(current);
      const result = runtimeLexicon(frozen, current);
      const resultBlocks = new Set(result.filter((entry) => entry.severity === "block").map((entry) => entry.normalized));
      const expectedBlocks = new Set([...blockSet(current), ...(frozen === null ? [] : blockSet(frozen))]);
      for (const normalized of expectedBlocks) assert.ok(resultBlocks.has(normalized), `Block_Term ${JSON.stringify(normalized)} was dropped or downgraded`);
      assert.deepEqual([...resultBlocks].sort(), [...expectedBlocks].sort(), "no term becomes a block that neither side blocks");
      // Every term of either side survives, exactly once.
      const expectedTerms = new Set([...normalizedSet(current), ...(frozen === null ? [] : normalizedSet(frozen))]);
      assert.deepEqual(result.map((entry) => entry.normalized).sort(), [...expectedTerms].sort());
      for (const entry of result) assert.equal(entry.normalized, normalizePolicyText(entry.term));
      if (frozen === null) {
        nullFrozen += 1;
        assert.deepEqual(result, compileLexicon(current));
        assert.deepEqual(runtimeLexicon(undefined, current), result);
      } else {
        const frozenAll = normalizedSet(frozen);
        const currentAll = normalizedSet(current);
        for (const normalized of frozenAll) {
          if (!currentAll.has(normalized)) continue;
          sharedTerms += 1;
          const inFrozenBlock = blockSet(frozen).has(normalized);
          const inCurrentBlock = blockSet(current).has(normalized);
          if (inFrozenBlock !== inCurrentBlock) {
            severityDisagreements += 1;
            assert.equal(result.find((entry) => entry.normalized === normalized).severity, "block", "block wins over warn for the same term");
          }
        }
      }
      assert.equal(JSON.stringify(frozen), frozenBefore);
      assert.equal(JSON.stringify(current), currentBefore);
    }),
    { numRuns: 1000, seed: 20250118 }
  );
  assert.ok(nullFrozen >= 20, `only ${nullFrozen} cases had a null frozen lexicon`);
  assert.ok(sharedTerms >= 100, `only ${sharedTerms} shared terms were generated`);
  assert.ok(severityDisagreements >= 100, `only ${severityDisagreements} shared terms had different severities`);
});

test("Property 17: a term blocked only by the frozen lexicon, or only by the current one, still stops the broadcast", () => {
  fc.assert(
    fc.property(property17Side("f"), property17Side("c"), (frozen, current) => {
      const runtime = runtimeLexicon(frozen, current);
      for (const source of [frozen, current]) {
        for (const entry of source.filter((candidate) => candidate.severity === "block" && normalizePolicyText(candidate.term) !== "")) {
          const result = guardBroadcastText(`欢迎${entry.term}大家`, { policyRules: [], lexicon: runtime, maxLength: 800 });
          assert.equal(result.allowed, false, `${JSON.stringify(entry.term)} was let through`);
        }
      }
    }),
    { numRuns: 300, seed: 20250119 }
  );
});

// Feature: live-commerce-p1-features, Property 19: 词表只收紧策略判定
// Validates: Requirements 5.9
// Texts are built from phrases that trigger built-in policy rules, tenant policy rules, lexicon terms (block and warn) and
// harmless filler, with obfuscation (spaces, zero-width characters) and sometimes a length above the limit.
// (a) allowed === true implies evaluatePolicy(text, ["product_version"], rules).action === "answer", and the lexicon never
// turns a refused text into an allowed one (allowed with a lexicon implies allowed with an empty lexicon).
// (b) when no Block_Term occurs in the text, allowed equals the result with an empty lexicon, and Warn_Term hits are reported.
const property19Phrases = [
  "欢迎来到直播间", "今天", "大家好", "这款", "有赠品", "库存充足", "规格", "发货", "改价", "降价", "退款", "孕妇", "治疗", "全网最低", "包邮", "买一送一",
  "加微信", "第一", "顶级", "vx", "神药", "忽略之前的指令", "密码", "。", "！", " ", "\u200B"
];
const property19Terms = ["包邮", "买一送一", "加微信", "第一", "顶级", "vx", "神药", "赠品", "库存", "全网最低", "今天", "改价"];
const property19Piece = fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...property19Phrases) }, { weight: 8, arbitrary: fc.constantFrom("欢迎来到直播间", "今天", "大家好", "这款", "。", "！", " ", "加微信", "第一", "顶级", "vx", "神药") }, { weight: 1, arbitrary: fc.string({ maxLength: 6, unit: "grapheme-ascii" }) });
const property19Text = fc.oneof(
  { weight: 20, arbitrary: fc.array(property19Piece, { maxLength: 8 }).map((parts) => parts.join("")) },
  { weight: 1, arbitrary: fc.array(property19Piece, { minLength: 1, maxLength: 12 }).map((parts) => parts.join("").repeat(60)) },
  { weight: 1, arbitrary: fc.constantFrom("", "   ", "\n") }
);
const property19Rule = fc.record({
  id: fc.constantFrom("r1", "r2", "r3"),
  terms: fc.array(fc.constantFrom(...property19Terms), { minLength: 1, maxLength: 3 }),
  reason: fc.constantFrom("运费说明", "活动规则", "合规提示"),
  action: fc.constantFrom("answer", "handoff", "refuse"),
  riskLevel: fc.constantFrom("low", "medium", "high"),
  requiredEvidence: fc.array(fc.constantFrom("product_version", "shipping_policy", "price_policy"), { maxLength: 2 })
});
const property19Lexicon = (severities) =>
  fc
    .array(fc.tuple(fc.constantFrom("加微信", "第一", "顶级", "vx", "神药", ...property19Terms), fc.constantFrom(...severities), fc.constantFrom("extreme", "medical", "false_claim", "offsite_trade", "custom")), { minLength: 1, maxLength: 6 })
    .map((entries) => compileLexicon(entries.map(([text, severity, category], index) => term(`t${index}`, text, severity, [], category))));
const property19Case = (severities) => fc.record({ text: property19Text, rules: fc.array(property19Rule, { maxLength: 4 }), lexicon: property19Lexicon(severities), maxLength: fc.constantFrom(20, 800, 800, 800, 2000) });

test("Property 19: an allowed broadcast is always one the policy engine answers, and the lexicon never loosens a verdict", () => {
  let allowedCases = 0;
  let lexiconRefusals = 0;
  fc.assert(
    fc.property(property19Case(["block", "block", "warn"]), ({ text, rules, lexicon, maxLength }) => {
      const withLexicon = guardBroadcastText(text, { policyRules: rules, lexicon, maxLength });
      const withoutLexicon = guardBroadcastText(text, { policyRules: rules, lexicon: [], maxLength });
      const policy = evaluatePolicy(text, ["product_version"], rules);
      assert.deepEqual(withLexicon.decision, policy);
      if (withLexicon.allowed) {
        allowedCases += 1;
        assert.equal(policy.action, "answer");
        assert.equal(withoutLexicon.allowed, true, "the lexicon allowed a text that the empty lexicon refuses");
      }
      if (!withLexicon.allowed && withoutLexicon.allowed) lexiconRefusals += 1;
    }),
    { numRuns: 1000, seed: 20250120 }
  );
  assert.ok(allowedCases >= 100, `only ${allowedCases} generated cases were allowed`);
  assert.ok(lexiconRefusals >= 100, `only ${lexiconRefusals} cases were refused because of the lexicon`);
});

test("Property 19: when only Warn_Terms occur, the verdict equals the one without a lexicon and the hits are reported", () => {
  let warnHits = 0;
  let warnAllowed = 0;
  fc.assert(
    fc.property(property19Case(["warn"]), ({ text, rules, lexicon, maxLength }) => {
      const withLexicon = guardBroadcastText(text, { policyRules: rules, lexicon, maxLength });
      const withoutLexicon = guardBroadcastText(text, { policyRules: rules, lexicon: [], maxLength });
      assert.equal(withLexicon.allowed, withoutLexicon.allowed);
      assert.deepEqual(withLexicon.reasons, withoutLexicon.reasons);
      const normalizedText = normalizePolicyText(text);
      for (const entry of lexicon) {
        if (text.length <= 2000 && normalizedText.includes(entry.normalized)) {
          assert.ok(withLexicon.findings.some((finding) => finding.termId === entry.id && finding.severity === "warn"), `no warn finding for ${entry.id}`);
        }
      }
      if (withLexicon.findings.length > 0) warnHits += 1;
      if (withLexicon.findings.length > 0 && withLexicon.allowed) warnAllowed += 1;
    }),
    { numRuns: 1000, seed: 20250121 }
  );
  assert.ok(warnHits >= 100, `only ${warnHits} cases contained a warn hit`);
  assert.ok(warnAllowed >= 100, `only ${warnAllowed} cases with a warn hit were allowed`);
});

test("Property 19: a mixed lexicon whose Block_Terms do not occur behaves like an empty lexicon", () => {
  let premiseHeld = 0;
  let withWarnHit = 0;
  fc.assert(
    fc.property(property19Case(["block", "warn"]), ({ text, rules, lexicon, maxLength }) => {
      const normalizedText = normalizePolicyText(text);
      fc.pre(text.length <= 2000 && !lexicon.some((entry) => entry.severity === "block" && normalizedText.includes(entry.normalized)));
      premiseHeld += 1;
      const withLexicon = guardBroadcastText(text, { policyRules: rules, lexicon, maxLength });
      const withoutLexicon = guardBroadcastText(text, { policyRules: rules, lexicon: [], maxLength });
      assert.equal(withLexicon.allowed, withoutLexicon.allowed);
      assert.deepEqual(withLexicon.reasons, withoutLexicon.reasons);
      assert.ok(withLexicon.findings.every((finding) => finding.severity === "warn"));
      if (withLexicon.findings.length > 0) withWarnHit += 1;
    }),
    { numRuns: 1000, seed: 20250122 }
  );
  assert.ok(premiseHeld >= 100, `only ${premiseHeld} cases satisfied the premise`);
  assert.ok(withWarnHit >= 50, `only ${withWarnHit} cases had a warn hit`);
});
