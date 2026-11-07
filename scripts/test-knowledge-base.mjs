// Unit tests of the knowledge base matching (design.md module D): tokenization, scoring and ranking in
// apps/console/lib/shared/knowledge-match.mjs, which the console and the runtime worker both run.
// No database is involved.
//
//   node --test scripts/test-knowledge-base.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import fc from "fast-check";
import * as interactionRules from "../apps/runtime-worker/interaction-rules.mjs";
import { normalizePolicyText } from "../apps/console/lib/shared/policy-engine.mjs";
import { chunkKnowledgeDocument, knowledgeQueryTerms, knowledgeSearchTerms, rankKnowledgeHits, scoreKnowledgeEntry } from "../apps/console/lib/shared/knowledge-match.mjs";
register("./lib/console-ts-loader.mjs", import.meta.url);
for (const name of ["DATABASE_URL", "CONTROL_PLANE_DEMO_MODE"]) delete process.env[name];
Object.assign(process.env, { CONTROL_PLANE_DEV_HEADER_IDENTITY: "true", NODE_ENV: "development", HOSTNAME: "127.0.0.1" });
const knowledgeService = await import("../apps/console/lib/knowledge-base.ts");
const knowledgeRoutes = {
  list: await import("../apps/console/app/api/v1/knowledge-entries/route.ts"),
  item: await import("../apps/console/app/api/v1/knowledge-entries/[entryId]/route.ts"),
  approve: await import("../apps/console/app/api/v1/knowledge-entries/[entryId]/approve/route.ts"),
  search: await import("../apps/console/app/api/v1/knowledge-entries/search/route.ts")
};
const knowledgeDocumentsRoute = await import("../apps/console/app/api/v1/knowledge-documents/route.ts");
const responseDraftRoute = await import("../apps/console/app/api/v1/live-runs/[runId]/response-drafts/route.ts");
const replyDraftRoute = await import("../apps/console/app/api/v1/live-runs/[runId]/reply-drafts/route.ts");
const channelInteractions = await import("../apps/console/lib/interactions.ts");
const channels = await import("../apps/console/lib/channels.ts");
const controlPlaneStore = await import("../apps/console/lib/control-plane/store.ts");
const knowledgeHeaders = (role = "admin", actorId = `knowledge-test-${role}`, tenantId = "tenant_demo") => ({ "x-tenant-id": tenantId, "x-actor-id": actorId, "x-actor-name": "Knowledge API Test", "x-actor-role": role, "content-type": "application/json" });
const callKnowledgeRoute = async (handler, url, { method = "GET", body, role = "admin", actorId, tenantId, params = {} } = {}) => {
  const response = await handler(new Request(`http://127.0.0.1${url}`, { method, headers: knowledgeHeaders(role, actorId, tenantId), body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
};
const validKnowledgeEntry = (overrides = {}) => ({ kind: "faq", question: "退货规则是什么？", aliasQuestions: ["如何申请退货？"], answer: "支持七天内申请退货。", keywords: ["退货"], ...overrides });
const knowledgeEntryPath = (entryId) => `/api/v1/knowledge-entries/${entryId}`;
const callKnowledgeItem = (method, entryId, options = {}) => callKnowledgeRoute(knowledgeRoutes.item[method], knowledgeEntryPath(entryId), { ...options, method, params: { entryId } });
const callKnowledgeApproval = (entryId, options = {}) => callKnowledgeRoute(knowledgeRoutes.approve.POST, `${knowledgeEntryPath(entryId)}/approve`, { ...options, method: "POST", params: { entryId } });

// normalizePolicyText applied until it stops changing: one pass is not stable for e + U+200B + U+0301.
const normalizeStable = (value) => {
  let current = normalizePolicyText(value);
  for (let pass = 0; pass < 8; pass += 1) {
    const next = normalizePolicyText(current);
    if (next === current) break;
    current = next;
  }
  return current;
};

const entry = (overrides = {}) => ({ entryId: "00000000-0000-4000-8000-000000000001", question: "什么时候发货", aliasQuestions: [], keywords: ["发货"], ...overrides });

describe("chunkKnowledgeDocument", () => {
  test("drops whitespace, preserves non-whitespace order, and stays within 300 code points", () => {
    assert.deepEqual(chunkKnowledgeDocument(" \n\t\n "), []);
    const body = "第一句说明。第二句继续！\n仍在本段。\n\n新段落，文本保持。";
    const chunks = chunkKnowledgeDocument(body);
    assert.equal(chunks.join("").replace(/\s/gu, ""), body.replace(/\s/gu, ""));
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 300));
    assert.ok(chunks.every((chunk) => chunk.trim().length > 0));
  });

  test("accepts 50000 characters and rejects 50001 with a reason", () => {
    assert.ok(chunkKnowledgeDocument("发".repeat(50_000)).length > 0);
    assert.throws(() => chunkKnowledgeDocument("发".repeat(50_001)), (error) => error.reason === "body_too_large");
  });

  test("accepts 200 chunks and rejects 201 chunks with a reason", () => {
    assert.equal(chunkKnowledgeDocument(Array.from({ length: 200 }, (_, index) => `段落${index}。`).join("\n\n")).length, 200);
    assert.throws(() => chunkKnowledgeDocument(Array.from({ length: 201 }, (_, index) => `段落${index}。`).join("\n\n")), (error) => error.reason === "too_many_chunks");
  });

  test("splits a single long sentence without losing characters", () => {
    const body = "长".repeat(901);
    const chunks = chunkKnowledgeDocument(body);
    assert.equal(chunks.length, 4);
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 300));
    assert.equal(chunks.join(""), body);
  });
});

describe("knowledgeQueryTerms", () => {
  test("splits Chinese into adjacent bigrams", () => {
    assert.deepEqual(knowledgeQueryTerms("控油面膜"), ["控油", "油面", "面膜"]);
  });
  test("keeps ASCII alphanumeric words of two or more characters next to CJK bigrams", () => {
    assert.deepEqual(knowledgeQueryTerms("SPF50能用吗"), ["spf50", "用吗", "能用"].sort());
  });
  test("an isolated CJK character is a term; a single ASCII character is not", () => {
    assert.deepEqual(knowledgeQueryTerms("油"), ["油"]);
    assert.deepEqual(knowledgeQueryTerms("a，油，b"), ["油"]);
  });
  test("whitespace and full-width characters do not change the terms", () => {
    const plain = knowledgeQueryTerms("SPF50控油面膜");
    assert.deepEqual(knowledgeQueryTerms(" ＳＰＦ５０ 控 油　面膜 "), plain);
    assert.deepEqual(knowledgeQueryTerms("ＳＰＦ５０"), ["spf50"]);
  });
  test("punctuation separates runs", () => {
    assert.deepEqual(knowledgeQueryTerms("发货，快递"), ["发货", "快递"]);
  });
  test("equals the terms of the normalized text even when one normalization pass is not stable", () => {
    const text = "e\u200B\u0301发货";
    assert.notEqual(normalizePolicyText(normalizePolicyText(text)), normalizePolicyText(text));
    assert.deepEqual(knowledgeQueryTerms(text), knowledgeQueryTerms(normalizePolicyText(text)));
    assert.deepEqual(knowledgeQueryTerms(text), ["发货"]);
  });
  test("is empty for text without searchable characters", () => {
    assert.deepEqual(knowledgeQueryTerms(""), []);
    assert.deepEqual(knowledgeQueryTerms("！？ 。"), []);
  });
});

describe("knowledgeSearchTerms", () => {
  test("unites question, alias and keyword terms and ignores the answer", () => {
    const terms = knowledgeSearchTerms({ question: "发货时间", aliasQuestions: ["多久到"], keywords: ["SPF50"], answer: "今天下午三点" });
    assert.deepEqual(terms, ["发货", "货时", "时间", "多久", "久到", "spf50"].sort());
  });
  test("is capped at 2000 terms", () => {
    const text = Array.from({ length: 2500 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
    assert.equal(knowledgeSearchTerms({ question: text, aliasQuestions: [], keywords: [] }).length, 2000);
  });
});

describe("scoreKnowledgeEntry", () => {
  test("a keyword whose search terms are all question terms scores at least 600", () => {
    const { scorePermille, keywordHits } = scoreKnowledgeEntry("什么时候发货呀", entry());
    assert.equal(keywordHits, 1);
    assert.equal(scorePermille, 873);
    assert.ok(scoreKnowledgeEntry("发货", entry({ question: "完全不同的问题内容" })).scorePermille >= 600);
  });
  test("a single Chinese character or a part of an ASCII word does not hit, even as a substring of the question", () => {
    for (const [question, keyword] of [
      ["控油面膜", "油"],
      ["spf50", "spf"]
    ]) {
      const unrelated = { question: "完全不同的问题内容", aliasQuestions: [] };
      const withKeyword = scoreKnowledgeEntry(question, { ...unrelated, keywords: [keyword] });
      assert.equal(withKeyword.keywordHits, 0, `${keyword} in ${question}`);
      assert.deepEqual(withKeyword, scoreKnowledgeEntry(question, { ...unrelated, keywords: [] }));
      const sameQuestion = { question, aliasQuestions: [] };
      assert.deepEqual(scoreKnowledgeEntry(question, { ...sameQuestion, keywords: [keyword] }), scoreKnowledgeEntry(question, { ...sameQuestion, keywords: [] }));
    }
  });
  test("a single Chinese character or an ASCII part hits when it is a standalone word of the question", () => {
    const unrelated = { question: "完全不同的问题内容", aliasQuestions: [] };
    for (const [question, keyword] of [
      ["油？", "油"],
      ["spf-50", "spf"]
    ]) {
      const { keywordHits, scorePermille } = scoreKnowledgeEntry(question, { ...unrelated, keywords: [keyword] });
      assert.equal(keywordHits, 1, `${keyword} in ${question}`);
      assert.ok(scorePermille >= 600);
    }
  });
  test("a keyword with no search terms never hits: one ASCII character, or only symbols", () => {
    const unrelated = { question: "完全不同的问题内容", aliasQuestions: [] };
    for (const [question, keyword] of [
      ["a", "a"],
      ["x，a，y", "a"],
      ["发货？！", "？！"],
      ["发货", ""]
    ]) {
      assert.equal(scoreKnowledgeEntry(question, { ...unrelated, keywords: [keyword] }).keywordHits, 0, `${JSON.stringify(keyword)} in ${question}`);
    }
  });
  test("every term of a multi-term keyword must be a question term", () => {
    const unrelated = { question: "完全不同的问题内容", aliasQuestions: [] };
    assert.equal(scoreKnowledgeEntry("什么时候发货", { ...unrelated, keywords: ["发货时间"] }).keywordHits, 0);
    assert.equal(scoreKnowledgeEntry("发货时间", { ...unrelated, keywords: ["发货时间"] }).keywordHits, 1);
  });
  test("the same question as the entry scores 1000", () => {
    assert.equal(scoreKnowledgeEntry("什么时候发货", entry({ keywords: [] })).scorePermille, 1000);
  });
  test("an unrelated question scores 0", () => {
    assert.deepEqual(scoreKnowledgeEntry("你好", entry()), { scorePermille: 0, keywordHits: 0 });
  });
  test("the best of the question and its aliases counts, and each extra keyword adds 100", () => {
    const withAlias = scoreKnowledgeEntry("多久能到", entry({ keywords: [], aliasQuestions: ["多久能到"] }));
    assert.equal(withAlias.scorePermille, 1000);
    const twoKeywords = scoreKnowledgeEntry("发货快递", entry({ question: "无关内容", keywords: ["发货", "快递"] }));
    assert.equal(twoKeywords.keywordHits, 2);
    assert.equal(twoKeywords.scorePermille, 700);
  });
});

describe("rankKnowledgeHits", () => {
  const first = entry();
  const other = entry({ entryId: "00000000-0000-4000-8000-000000000002", question: "怎么退货", keywords: ["退货"] });
  test("matched: the best entry above the threshold", () => {
    const result = rankKnowledgeHits("什么时候发货呀", [other, first], { minScorePermille: 600 });
    assert.equal(result.reason, "matched");
    assert.equal(result.hit.entryId, first.entryId);
    assert.equal(result.hit.scorePermille, 873);
  });
  test("below_threshold: the best score is under the minimum", () => {
    assert.deepEqual(rankKnowledgeHits("什么时候发货呀", [first, other], { minScorePermille: 900 }), { hit: null, reason: "below_threshold" });
  });
  test("ambiguous: a different entry scores within the margin", () => {
    const twin = entry({ entryId: "00000000-0000-4000-8000-000000000003" });
    assert.deepEqual(rankKnowledgeHits("什么时候发货呀", [first, twin], { minScorePermille: 600 }), { hit: null, reason: "ambiguous" });
  });
  test("no_candidates: nothing to rank", () => {
    assert.deepEqual(rankKnowledgeHits("什么时候发货呀", [], { minScorePermille: 600 }), { hit: null, reason: "no_candidates" });
  });
  test("equal scores order by entryId, whatever the input order", () => {
    const twin = entry({ entryId: "00000000-0000-4000-8000-000000000003" });
    const options = { minScorePermille: 600, ambiguityMarginPermille: 0 };
    assert.equal(rankKnowledgeHits("什么时候发货呀", [twin, first], options).hit.entryId, first.entryId);
    assert.equal(rankKnowledgeHits("什么时候发货呀", [first, twin], options).hit.entryId, first.entryId);
  });
});
describe("knowledgeQueryTerms properties", () => {
  // Feature: live-commerce-p1-features, Property 10: 检索词对规范化不变
  // Validates: Requirements 4.6, 4.7
  const fragment = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom("发", "货", "控", "油", "面", "膜", "什么时候", "多久能到", "你好", "ひらがな", "カタカナ", "한국어") },
    { weight: 4, arbitrary: fc.constantFrom("a", "B", "spf", "SPF50", "50", "x", "Z9", "ab_cd", "e") },
    { weight: 2, arbitrary: fc.constantFrom("ＳＰＦ５０", "Ａｂ", "，", "！", "？", "。", "（", "ｅ", "ｘ１") },
    { weight: 2, arbitrary: fc.constantFrom(" ", "\t", "\n", "\u3000", "\u00A0", "\u2003") },
    { weight: 2, arbitrary: fc.constantFrom("\u200B", "\u200C", "\u200D", "\uFEFF") },
    { weight: 2, arbitrary: fc.constantFrom("\u0301", "\u0308", "\u3099", "\u0323", "\u1100\u1161", "ﬁ", "㎏", "①", "İ", "ǅ") },
    { weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) },
    { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 3 }) }
  );
  const anyText = fc.array(fragment, { maxLength: 24 }).map((parts) => parts.join(""));
  const insertion = fc.constantFrom("", " ", "\t", "\n", "\u3000", "\u00A0", "\u200B", "\u200C", "\u200D", "\uFEFF", " \u200B ");
  const toFullWidth = (char) => {
    const code = char.charCodeAt(0);
    return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char;
  };

  test("the terms of a text equal the terms of its normalized text", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        assert.deepEqual(knowledgeQueryTerms(text), knowledgeQueryTerms(normalizePolicyText(text)));
      }),
      { seed: 10301, numRuns: 500 }
    );
  });

  test("inserting whitespace or zero-width characters anywhere does not change the terms", () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.record({ at: fc.nat(), text: insertion }), { maxLength: 8 }), (text, insertions) => {
        let changed = text;
        for (const { at, text: inserted } of insertions) {
          const index = changed.length === 0 ? 0 : at % (changed.length + 1);
          changed = changed.slice(0, index) + inserted + changed.slice(index);
        }
        assert.deepEqual(knowledgeQueryTerms(changed), knowledgeQueryTerms(text));
      }),
      { seed: 10302, numRuns: 500 }
    );
  });

  test("replacing ASCII characters with their full-width forms does not change the terms", () => {
    fc.assert(
      fc.property(anyText, fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (text, mask) => {
        const replaced = Array.from(text, (char, index) => (mask[index % mask.length] ? toFullWidth(char) : char)).join("");
        assert.deepEqual(knowledgeQueryTerms(replaced), knowledgeQueryTerms(text));
      }),
      { seed: 10303, numRuns: 500 }
    );
  });
});

describe("scoreKnowledgeEntry properties", () => {
  // Feature: live-commerce-p1-features, Property 11: 打分范围与关键词下限
  // Validates: Requirements 4.8
  // Text built from a small vocabulary so that questions, aliases and keywords overlap often, plus
  // full-width, whitespace, zero-width and combining fragments so normalization is exercised.
  const fragment = fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom("发", "货", "控", "油", "面", "膜", "什么时候", "多久能到", "快递", "退货", "你好", "한국어", "カタカナ") },
    { weight: 3, arbitrary: fc.constantFrom("a", "B", "spf", "SPF50", "50", "x", "Z9", "e") },
    { weight: 2, arbitrary: fc.constantFrom("ＳＰＦ５０", "Ａｂ", "，", "！", "？", "。", "ｅ") },
    { weight: 1, arbitrary: fc.constantFrom(" ", "\t", "\u3000", "\u200B", "\u200C", "\uFEFF", "\u0301", "\u0308", "ﬁ", "㎏", "①", "İ") },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) }
  );
  const text = fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(""));
  const looseEntry = fc.record({
    entryId: fc.uuid(),
    question: text,
    aliasQuestions: fc.array(text, { maxLength: 5 }),
    keywords: fc.array(text, { maxLength: 20 })
  });

  test("the score is an integer from 0 to 1000 and keywordHits is an integer from 0 to the keyword count", () => {
    fc.assert(
      fc.property(text, looseEntry, (question, candidate) => {
        const { scorePermille, keywordHits } = scoreKnowledgeEntry(question, candidate);
        assert.ok(Number.isInteger(scorePermille), `score ${scorePermille} is not an integer`);
        assert.ok(scorePermille >= 0 && scorePermille <= 1000, `score ${scorePermille} is out of range`);
        assert.ok(Number.isInteger(keywordHits) && keywordHits >= 0 && keywordHits <= candidate.keywords.length);
      }),
      { seed: 10401, numRuns: 500 }
    );
  });

  test("an entry with a keyword made of question search terms scores between 600 and 1000", () => {
    // Keywords are non-empty subsets of the question's search terms, joined with an ASCII comma: joining them
    // end to end would create bigrams that are not question terms.
    const questionWithTerms = text.filter((value) => knowledgeQueryTerms(value).length > 0);
    fc.assert(
      fc.property(
        questionWithTerms,
        fc.array(text, { maxLength: 5 }),
        text,
        fc.array(fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 20 }),
        fc.array(text, { maxLength: 3 }),
        (question, aliasQuestions, entryQuestion, picks, noiseKeywords) => {
          const questionTerms = knowledgeQueryTerms(question);
          const keywords = picks.map((indexes) => [...new Set(indexes.map((index) => questionTerms[index % questionTerms.length]))].join(","));
          const { scorePermille, keywordHits } = scoreKnowledgeEntry(question, { question: entryQuestion, aliasQuestions, keywords: [...noiseKeywords, ...keywords] });
          assert.ok(keywordHits >= keywords.length, `${keywordHits} hits for ${JSON.stringify(keywords)} in terms ${JSON.stringify(questionTerms)}`);
          assert.ok(scorePermille >= 600 && scorePermille <= 1000, `score ${scorePermille} for keywords ${JSON.stringify(keywords)}`);
        }
      ),
      { seed: 10402, numRuns: 500 }
    );
  });

  test("keywords that are substrings of the question but not made of question search terms do not count", () => {
    // Substrings of the normalized question (length 1 included: single CJK characters, parts of ASCII words,
    // single ASCII characters, symbols) kept only when the new definition says they cannot hit.
    const substring = fc.record({ start: fc.nat(), length: fc.oneof({ weight: 3, arbitrary: fc.constant(1) }, { weight: 3, arbitrary: fc.integer({ min: 1, max: 4 }) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 64 }) }) });
    const symbolsOnly = fc.constantFrom("！", "？", "，。", "a", "Z", "5", "①", "-");
    const questionWithText = text.filter((value) => normalizeStable(value).length > 0);
    let generatedNonHits = 0;
    fc.assert(
      fc.property(
        questionWithText,
        fc.array(text, { maxLength: 5 }),
        text,
        fc.array(text, { maxLength: 6 }),
        fc.array(fc.oneof({ weight: 4, arbitrary: substring }, { weight: 1, arbitrary: symbolsOnly }), { minLength: 1, maxLength: 20 }),
        (question, aliasQuestions, entryQuestion, otherKeywords, picks) => {
          const normalized = Array.from(normalizeStable(question));
          const questionTerms = new Set(knowledgeQueryTerms(question));
          const cannotHit = (keyword) => {
            const terms = knowledgeQueryTerms(keyword);
            return terms.length === 0 || terms.some((term) => !questionTerms.has(term));
          };
          const nonHits = picks
            .map((pick) => {
              if (typeof pick === "string") return pick;
              const from = pick.start % normalized.length;
              return normalized.slice(from, from + pick.length).join("");
            })
            .filter(cannotHit);
          generatedNonHits += nonHits.length;
          // otherKeywords may hit; the nonHits must change neither the hits nor the score.
          const base = { question: entryQuestion, aliasQuestions, keywords: otherKeywords };
          const without = scoreKnowledgeEntry(question, base);
          const withNonHits = scoreKnowledgeEntry(question, { ...base, keywords: [...otherKeywords, ...nonHits] });
          assert.deepEqual(withNonHits, without, `non-hit keywords ${JSON.stringify(nonHits)} changed the result for ${JSON.stringify(normalized.join(""))}`);
          assert.ok(Number.isInteger(withNonHits.scorePermille) && withNonHits.scorePermille >= 0 && withNonHits.scorePermille <= 1000);
          assert.ok(withNonHits.keywordHits <= otherKeywords.length);
        }
      ),
      { seed: 10403, numRuns: 500 }
    );
    assert.ok(generatedNonHits > 500, `only ${generatedNonHits} non-hit keywords were generated`);
  });
});

describe("knowledge entry console routes", () => {
  test("route roles enforce tenant-wide CRUD and two-person approval", async () => {
    for (const role of ["admin", "operator", "reviewer", "analyst"]) assert.equal((await callKnowledgeRoute(knowledgeRoutes.list.GET, "/api/v1/knowledge-entries", { role })).status, 200, `${role} can list`);
    assert.equal((await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "reviewer", body: validKnowledgeEntry() })).status, 403);
    const created = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "kb-author", body: validKnowledgeEntry() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.equal(created.body.data.status, "pending");
    assert.equal((await callKnowledgeItem("GET", id, { role: "analyst" })).status, 200);
    assert.equal((await callKnowledgeItem("PUT", id, { role: "reviewer", body: { answer: "回复内容更正。" } })).status, 403);
    assert.equal((await callKnowledgeApproval(id, { role: "operator" })).status, 403);
    const selfApproval = await callKnowledgeApproval(id, { role: "admin", actorId: "kb-author" });
    assert.equal(selfApproval.status, 409);
    assert.equal(selfApproval.body.error, "knowledge_entry_second_approver_required");
    const approved = await callKnowledgeApproval(id, { role: "reviewer", actorId: "kb-reviewer" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, "approved");
    assert.ok(approved.body.data.approvedApprovalId);

    const edited = await callKnowledgeItem("PUT", id, { role: "operator", actorId: "kb-editor", body: { answer: "支持七天内申请退货，请联系客服办理。" } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.status, "pending");
    assert.equal(edited.body.data.revision, 2);
    assert.equal(edited.body.data.approvedApprovalId, undefined);
    assert.equal((await callKnowledgeApproval(id, { role: "admin", actorId: "kb-editor" })).status, 409);
    assert.equal((await callKnowledgeApproval(id, { role: "reviewer", actorId: "kb-reviewer-2" })).status, 200);

    const audit = globalThis.shuzhirenAuditStore.events.filter((event) => event.resourceId === id);
    assert.deepEqual([...audit].reverse().map((event) => event.type), ["knowledge_entry.created", "knowledge_entry.approved", "knowledge_entry.updated", "knowledge_entry.approved"]);
    const updatedEvent = audit.find((event) => event.type === "knowledge_entry.updated");
    const approvedEvent = audit.find((event, index) => event.type === "knowledge_entry.approved" && index === 0);
    assert.equal(updatedEvent.detail.approvalReset, true);
    assert.ok(approvedEvent.detail.approvalId);
    assert.match(approvedEvent.detail.answerSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(approvedEvent.detail).includes("支持七天内申请退货"), false);

    assert.equal((await callKnowledgeItem("DELETE", id, { role: "operator" })).status, 403);
    const retired = await callKnowledgeItem("DELETE", id, { role: "admin", actorId: "kb-admin" });
    assert.equal(retired.status, 200);
    assert.equal(retired.body.data.status, "retired");
    assert.equal((await callKnowledgeItem("PUT", id, { body: { answer: "不能再改" } })).status, 409);
    assert.equal((await callKnowledgeApproval(id, { role: "reviewer", actorId: "kb-reviewer-3" })).status, 409);
  });

  test("creation and update validate boundaries, searchable keywords, term count and product tenant", async () => {
    const create = (body) => callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", body });
    for (const invalid of [
      validKnowledgeEntry({ question: "问".repeat(201) }),
      validKnowledgeEntry({ aliasQuestions: Array.from({ length: 6 }, () => "别名") }),
      validKnowledgeEntry({ answer: "答".repeat(301) }),
      validKnowledgeEntry({ keywords: Array.from({ length: 21 }, (_, index) => `词${index}`) })
    ]) assert.equal((await create(invalid)).status, 400);
    for (const keyword of ["a", "！！"]) {
      const invalid = await create(validKnowledgeEntry({ keywords: [keyword] }));
      assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
      assert.ok(invalid.body.detail.issues.some((issue) => issue.value === keyword));
    }
    assert.equal((await create(validKnowledgeEntry({ keywords: ["油"] }))).status, 201, "one CJK character remains searchable");
    const oversizedTerms = knowledgeService.knowledgeEntryInputIssues(validKnowledgeEntry(), 2001);
    assert.ok(oversizedTerms.some((issue) => issue.field === "searchTerms"));
    const before = (await knowledgeRoutes.list.GET(new Request("http://127.0.0.1/api/v1/knowledge-entries", { headers: knowledgeHeaders("admin") }))).status;
    assert.equal(before, 200);
    const badProduct = await create(validKnowledgeEntry({ productId: "product_not_in_tenant" }));
    assert.equal(badProduct.status, 422);

    const created = await create(validKnowledgeEntry({ productId: "product_a102" }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const badUpdate = await callKnowledgeItem("PUT", created.body.data.id, { body: { keywords: ["！！"] } });
    assert.equal(badUpdate.status, 422);
    assert.equal((await callKnowledgeItem("PUT", created.body.data.id, { body: { question: "" } })).status, 400);
  });

  test("blocked text cannot be approved and tenant-wide service methods reject restricted members", async () => {
    const created = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "kb-block-author", body: validKnowledgeEntry({ answer: "全网最低价，欢迎选购。" }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const refused = await callKnowledgeApproval(created.body.data.id, { role: "reviewer", actorId: "kb-block-reviewer" });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "knowledge_entry_policy_blocked");
    assert.equal(refused.body.failures[0].field, "answer");
    assert.ok(refused.body.failures[0].findings.some((finding) => finding.term === "全网最低"));
    assert.equal((await callKnowledgeItem("GET", created.body.data.id)).body.data.status, "pending");

    const restricted = { tenantId: "tenant_knowledge_restricted", actorId: "restricted-operator", actorName: "Restricted", role: "operator", accessScope: "restricted" };
    await assert.rejects(knowledgeService.listKnowledgeEntries(restricted), (error) => error instanceof Response && error.status === 403);
    assert.equal((await callKnowledgeRoute(knowledgeRoutes.list.GET, "/api/v1/knowledge-entries", { role: "admin", actorId: "other-tenant-admin", tenantId: "tenant_knowledge_other" })).body.data.some((entry) => entry.id === created.body.data.id), false);
  });

  test("search preview returns approved snapshots, respects product binding, ambiguity and score bounds", async () => {
    const search = (question, { role = "analyst", actorId, ...bodyOptions } = {}) => callKnowledgeRoute(knowledgeRoutes.search.POST, "/api/v1/knowledge-entries/search", { method: "POST", body: { question, ...bodyOptions }, role, actorId });
    const question = "售后维修流程要怎样申请？";
    const createAndApprove = async (answer, { productId, author, reviewer } = {}) => {
      const created = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: author, body: validKnowledgeEntry({ question, aliasQuestions: [], answer, keywords: ["售后维修"], ...(productId ? { productId } : {}) }) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return { created, approved: await callKnowledgeApproval(created.body.data.id, { role: "reviewer", actorId: reviewer }) };
    };

    const pending = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "kb-search-pending", body: validKnowledgeEntry({ question, aliasQuestions: [], answer: "待批准内容。", keywords: ["售后维修"] }) });
    assert.equal(pending.status, 201);
    assert.equal((await search(question)).body.data.reason, "no_candidates");

    const first = await createAndApprove("先联系售后服务申请维修。", { author: "kb-search-author-1", reviewer: "kb-search-reviewer-1" });
    assert.equal(first.approved.status, 200, JSON.stringify(first.approved.body));
    const matched = await search(question);
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.data.reason, "matched");
    assert.equal(matched.body.data.hit.entryId, first.created.body.data.id);
    assert.equal(matched.body.data.hit.scorePermille, 900);
    assert.equal(matched.body.data.candidates[0].answerSha256.length, 64);

    const productSpecific = await createAndApprove("商品专属维修答复。", { productId: "product_a102", author: "kb-product-author", reviewer: "kb-product-reviewer" });
    assert.equal(productSpecific.approved.status, 200, JSON.stringify(productSpecific.approved.body));
    const bound = await search(question, { productId: "product_a102" });
    assert.equal(bound.body.data.reason, "ambiguous", "global and matching product-specific answers remain distinct candidates");
    assert.equal((await search(question, { productId: "product_missing" })).status, 422);

    const invalidThresholdLow = await callKnowledgeRoute(knowledgeRoutes.search.POST, "/api/v1/knowledge-entries/search", { method: "POST", body: { question, minScorePermille: 299 } });
    const invalidThresholdHigh = await callKnowledgeRoute(knowledgeRoutes.search.POST, "/api/v1/knowledge-entries/search", { method: "POST", body: { question, minScorePermille: 1001 } });
    assert.equal(invalidThresholdLow.status, 400);
    assert.equal(invalidThresholdHigh.status, 400);
    for (const role of ["admin", "operator", "reviewer", "analyst"]) assert.equal((await search(question, { role })).status, 200, `${role} can preview`);
    assert.equal((await callKnowledgeRoute(knowledgeRoutes.search.POST, "/api/v1/knowledge-entries/search", { method: "POST", role: "invalid", body: { question } })).status, 403);

    const retired = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "kb-search-retired-author", body: validKnowledgeEntry({ question: "寄件包装破损理赔如何申请？", aliasQuestions: [], answer: "下线内容。", keywords: ["破损理赔"] }) });
    assert.equal(retired.status, 201);
    assert.equal((await callKnowledgeItem("DELETE", retired.body.data.id, { role: "admin" })).status, 200);
    const retiredSearch = await search("寄件包装破损理赔如何申请？");
    assert.equal(retiredSearch.body.data.hit, null);
    assert.equal(retiredSearch.body.data.candidates.some((candidate) => candidate.entryId === retired.body.data.id), false);
  });

  test("worker hit lookup returns only a unique matched candidate and propagates SQL errors", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000011";
    const runId = "00000000-0000-4000-8000-000000000012";
    const row = (entryId, answer = "请联系售后服务申请维修。") => ({ approval_id: `00000000-0000-4000-8000-000000000013`, entry_id: entryId, revision: 1, question: "售后维修流程要怎样申请？", alias_questions: [], answer, keywords: ["售后维修"], search_terms: ["售后", "后维", "维修"], answer_sha256: "a".repeat(64) });
    const fakeClient = (rows, failure) => ({ query: async (sql) => {
      if (sql.includes("current_setting")) return { rows: [{ tenant_id: tenantId }] };
      if (failure) throw failure;
      assert.match(sql, /knowledge_answer_candidates\([\s\S]*20\)/);
      return { rows };
    } });
    const single = await knowledgeService.knowledgeHitsForRunInTransaction(fakeClient([row("00000000-0000-4000-8000-000000000014")]), runId, "售后维修流程要怎样申请？");
    assert.equal(single.length, 1);
    assert.equal(single[0].scorePermille, 900);
    assert.equal((await knowledgeService.knowledgeHitsForRunInTransaction(fakeClient([row("00000000-0000-4000-8000-000000000014"), row("00000000-0000-4000-8000-000000000015")]), runId, "售后维修流程要怎样申请？")).length, 0);
    await assert.rejects(knowledgeService.knowledgeHitsForRunInTransaction(fakeClient([], new Error("candidate function failed")), runId, "售后维修流程要怎样申请？"), /candidate function failed/);
  });

  test("response and channel reply drafts retain current approved knowledge evidence", async () => {
    const question = "如何申请直播专用退货服务？";
    const created = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "draft-knowledge-author", body: validKnowledgeEntry({ question, aliasQuestions: [], answer: "请在签收后联系客服办理退货服务。", keywords: ["退货"] }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const entryId = created.body.data.id;
    const approved = await callKnowledgeApproval(entryId, { role: "admin", actorId: "draft-knowledge-approver" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const approvalId = approved.body.data.approvedApprovalId;
    const responseContext = { tenantId: "tenant_demo", actorId: "draft-response-operator", actorName: "Draft Test", role: "operator", accessScope: "tenant" };
    const demoRun = await controlPlaneStore.getRun(responseContext, "run_20261101_001");
    const runId = "10000000-0000-4000-8000-000000000012";
    globalThis.shuzhirenControlStore.runs.set(runId, { ...demoRun, id: runId });
    const sourceInteraction = await channelInteractions.createInteraction(responseContext, { runId, question, evidenceIds: [] });
    const draft = await callKnowledgeRoute(responseDraftRoute.POST, `/api/v1/live-runs/${runId}/response-drafts`, { method: "POST", body: { question, interactionIds: [sourceInteraction.id] }, params: { runId } });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.data.text, "请在签收后联系客服办理退货服务。");
    const responseKnowledgeEvidence = draft.body.data.evidence.find((item) => item.type === "knowledge_entry");
    assert.deepEqual(draft.body.data.evidence, [
      { type: "interaction_evidence", ids: [sourceInteraction.id] },
      responseKnowledgeEvidence,
      { type: "product_version", id: "pv_a102_v1", revision: 1 }
    ]);
    assert.equal(responseKnowledgeEvidence.approvalId, approvalId);
    assert.equal(responseKnowledgeEvidence.entryId, entryId);
    assert.equal(responseKnowledgeEvidence.revision, 1);
    assert.match(responseKnowledgeEvidence.answerSha256, /^[0-9a-f]{64}$/);
    assert.equal(responseKnowledgeEvidence.scorePermille, 900);
    const badInteractionReference = await callKnowledgeRoute(responseDraftRoute.POST, `/api/v1/live-runs/${runId}/response-drafts`, { method: "POST", body: { question, interactionIds: ["not-a-run-interaction"] }, params: { runId } });
    assert.equal(badInteractionReference.status, 400);
    const fallback = await callKnowledgeRoute(responseDraftRoute.POST, `/api/v1/live-runs/${runId}/response-drafts`, { method: "POST", body: { question: "直播结束后如何收纳桌面补光灯？" }, params: { runId } });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.data.evidence.some((item) => item.type === "knowledge_entry"), false);
    const approvedSnapshot = globalThis.shuzhirenKnowledgeStore.approvals.get(approvalId);
    const originalAnswer = approvedSnapshot.answer;
    approvedSnapshot.answer = "答".repeat(801);
    const blockedRoute = await callKnowledgeRoute(responseDraftRoute.POST, `/api/v1/live-runs/${runId}/response-drafts`, { method: "POST", body: { question }, params: { runId } });
    approvedSnapshot.answer = originalAnswer;
    assert.equal(blockedRoute.status, 202);
    assert.equal(blockedRoute.body.data.status, "handoff");
    const context = { tenantId: "tenant_demo", actorId: "draft-reply-operator", actorName: "Draft Test", role: "operator", accessScope: "tenant" };
    await channels.getChannelConnection(context, "channel_demo");
    globalThis.shuzhirenChannelStore.connections.get("channel_demo").lastVerifiedAt = new Date().toISOString();
    const firstInteraction = await channelInteractions.createChannelInteraction(context, { runId, question, source: "viewer", channelConnectionId: "channel_demo", evidenceIds: [] });
    const callReply = (body, overrides = {}) => callKnowledgeRoute(replyDraftRoute.POST, `/api/v1/live-runs/${runId}/reply-drafts`, { method: "POST", role: "operator", actorId: context.actorId, body: { interactionId: firstInteraction.id, channelConnectionId: "channel_demo", body: "请联系客服办理。", ...body }, params: { runId }, ...overrides });
    const reply = await callReply({ knowledgeApprovalId: approvalId });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const replyKnowledgeEvidence = reply.body.data.evidenceSnapshot.find((item) => item.type === "knowledge_entry");
    assert.deepEqual(replyKnowledgeEvidence, { type: "knowledge_entry", approvalId, entryId, revision: 1, answerSha256: responseKnowledgeEvidence.answerSha256, scorePermille: responseKnowledgeEvidence.scorePermille });

    const secondInteraction = await channelInteractions.createChannelInteraction({ ...context, actorId: "draft-reply-operator-2" }, { runId, question, source: "viewer", channelConnectionId: "channel_demo", evidenceIds: [] });
    const secondReply = (knowledgeApprovalId, tenantId = "tenant_demo") => callKnowledgeRoute(replyDraftRoute.POST, `/api/v1/live-runs/${runId}/reply-drafts`, { method: "POST", role: "operator", actorId: "draft-reply-operator-2", tenantId, body: { interactionId: secondInteraction.id, channelConnectionId: "channel_demo", body: "请联系客服办理。", knowledgeApprovalId }, params: { runId } });
    const missing = await secondReply("missing-approval-id");
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error, "knowledge_approval_not_current");

    const foreign = await callKnowledgeRoute(knowledgeRoutes.list.POST, "/api/v1/knowledge-entries", { method: "POST", role: "operator", actorId: "foreign-draft-author", tenantId: "tenant_other", body: validKnowledgeEntry({ question: "异租户专用退货流程怎么申请？", aliasQuestions: [], keywords: ["退货"] }) });
    assert.equal(foreign.status, 201);
    const foreignApproved = await callKnowledgeApproval(foreign.body.data.id, { role: "admin", actorId: "foreign-draft-approver", tenantId: "tenant_other" });
    assert.equal(foreignApproved.status, 200);
    const crossTenant = await secondReply(foreignApproved.body.data.approvedApprovalId);
    assert.equal(crossTenant.status, 409);
    assert.equal(crossTenant.body.error, "knowledge_approval_not_current");

    const stale = await callKnowledgeItem("PUT", entryId, { role: "operator", actorId: "draft-knowledge-editor", body: { answer: "更新后的退货办理答复。" } });
    assert.equal(stale.status, 200);
    const expired = await secondReply(approvalId);
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error, "knowledge_approval_not_current");
    const unchanged = await secondReply(undefined);
    assert.equal(unchanged.status, 201, JSON.stringify(unchanged.body));
    assert.equal(unchanged.body.data.evidenceSnapshot.some((item) => item.type === "knowledge_entry"), false);
  });
});

describe("rankKnowledgeHits properties", () => {
  // Feature: live-commerce-p1-features, Property 12: 排序与输入顺序无关
  // Validates: Requirements 4.8, 4.9
  // Contents come from a small pool (so several candidates score the same and the entryId tie-break is
  // exercised) mixed with free-form text; every candidate gets its own entryId.
  const fragment = fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom("发", "货", "控", "油", "面", "膜", "什么时候", "多久能到", "快递", "退货", "你好") },
    { weight: 2, arbitrary: fc.constantFrom("a", "SPF50", "spf", "Z9", "ＳＰＦ５０", "，", "？", " ", "\u200B") },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) }
  );
  const text = fc.array(fragment, { maxLength: 8 }).map((parts) => parts.join(""));
  const content = fc.record({ question: text, aliasQuestions: fc.array(text, { maxLength: 3 }), keywords: fc.array(text, { maxLength: 5 }), answer: text });
  const pooled = fc.constantFrom(
    { question: "什么时候发货", aliasQuestions: [], keywords: ["发货"], answer: "a" },
    { question: "什么时候发货", aliasQuestions: ["多久能到"], keywords: ["发货"], answer: "b" },
    { question: "怎么退货", aliasQuestions: [], keywords: ["退货"], answer: "c" },
    { question: "控油面膜", aliasQuestions: ["面膜控油"], keywords: [], answer: "d" }
  );
  const scenario = fc
    .array(fc.oneof({ weight: 3, arbitrary: pooled }, { weight: 2, arbitrary: content }), { maxLength: 10 })
    .chain((contents) =>
      fc.record({
        candidates: fc.uniqueArray(fc.uuid(), { minLength: contents.length, maxLength: contents.length }).map((ids) => contents.map((one, index) => ({ entryId: ids[index], ...one }))),
        order: fc.array(fc.nat(), { minLength: contents.length, maxLength: contents.length }),
        question: fc.oneof({ weight: 3, arbitrary: fc.constantFrom("什么时候发货呀", "怎么退货", "控油面膜", "多久能到", "SPF50能用吗") }, { weight: 2, arbitrary: text }),
        minScorePermille: fc.integer({ min: 300, max: 1000 }),
        ambiguityMarginPermille: fc.oneof({ weight: 1, arbitrary: fc.constant(undefined) }, { weight: 2, arbitrary: fc.integer({ min: 0, max: 1000 }) })
      })
    );

  test("the hit and the reason do not depend on the order of the candidates", () => {
    const seen = new Set();
    fc.assert(
      fc.property(scenario, ({ candidates, order, question, minScorePermille, ambiguityMarginPermille }) => {
        const options = ambiguityMarginPermille === undefined ? { minScorePermille } : { minScorePermille, ambiguityMarginPermille };
        const permuted = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => order[a.index] - order[b.index] || a.index - b.index).map(({ candidate }) => candidate);
        const expected = rankKnowledgeHits(question, candidates, options);
        seen.add(expected.reason);
        assert.deepEqual(rankKnowledgeHits(question, permuted, options), expected);
        assert.deepEqual(rankKnowledgeHits(question, [...candidates].reverse(), options), expected);
      }),
      { seed: 10501, numRuns: 500 }
    );
    // The generator must reach every outcome, otherwise the property would pass vacuously.
    for (const reason of ["matched", "below_threshold", "ambiguous", "no_candidates"]) assert.ok(seen.has(reason), `no generated case ended in ${reason}`);
  });
});

describe("knowledge retrieval prefilter property", () => {
  // Feature: live-commerce-p1-features, Property 13: 检索预筛不漏掉可得分条目
  // Validates: Requirements 4.6, 4.8, 4.10
  // Small alphabet (a few CJK characters, ASCII letters and digits, punctuation) so that questions and entries
  // share search terms in some samples and not in others. Keywords are also cut from the question itself: that
  // yields single CJK characters ("油" for "控油面膜"), parts of ASCII words ("spf" for "spf50"), single ASCII
  // characters and symbols, the substring cases the earlier keyword definition scored at 600 or more.
  const fragment = fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom("发", "货", "控", "油", "面", "膜", "快递", "你好") },
    { weight: 3, arbitrary: fc.constantFrom("a", "b", "spf", "SPF50", "50", "x", "9") },
    { weight: 2, arbitrary: fc.constantFrom("，", "！", "？", "。", "-", " ") },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 2 }) }
  );
  const text = fc.array(fragment, { maxLength: 6 }).map((parts) => parts.join(""));
  const question = fc.oneof({ weight: 2, arbitrary: fc.constantFrom("控油面膜", "spf50", "SPF50能用吗", "油？", "spf-50", "发货", "控油，发货") }, { weight: 3, arbitrary: text });
  const cut = fc.record({ start: fc.nat(), length: fc.integer({ min: 1, max: 4 }) });
  const keyword = fc.oneof({ weight: 3, arbitrary: text }, { weight: 4, arbitrary: cut }, { weight: 1, arbitrary: fc.constantFrom("油", "spf", "a", "！？") });
  const scenario = fc.record({
    question,
    entryQuestion: text,
    aliasQuestions: fc.array(text, { maxLength: 5 }),
    keywords: fc.array(keyword, { maxLength: 20 })
  });

  const isAsciiWord = (value) => /^[a-z0-9]+$/.test(value);
  const isCjkChar = (value) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(value);

  test("an entry sharing no search term with the question scores 0 with no keyword hits", () => {
    const seen = { disjoint: 0, overlapping: 0, singleCjk: 0, asciiPart: 0, singleAscii: 0, symbolsOnly: 0, nonSubstring: 0 };
    fc.assert(
      fc.property(scenario, (generated) => {
        const normalizedQuestion = normalizeStable(generated.question);
        const characters = Array.from(normalizedQuestion);
        const keywords = generated.keywords.map((one) => {
          if (typeof one === "string") return one;
          return characters.length === 0 ? "" : characters.slice(one.start % characters.length, (one.start % characters.length) + one.length).join("");
        });
        const candidate = { question: generated.entryQuestion, aliasQuestions: generated.aliasQuestions, keywords };
        const queryTerms = knowledgeQueryTerms(generated.question);
        const searchTerms = knowledgeSearchTerms(candidate);
        if (searchTerms.length >= 2000) return; // truncated: outside the property's premise
        const shared = searchTerms.filter((term) => queryTerms.includes(term));
        if (shared.length > 0) {
          seen.overlapping += 1;
          return;
        }
        seen.disjoint += 1;
        for (const one of keywords) {
          const normalized = normalizeStable(one);
          if (normalized.length === 0) continue;
          if (!normalizedQuestion.includes(normalized)) {
            seen.nonSubstring += 1;
            continue;
          }
          if (isCjkChar(normalized)) seen.singleCjk += 1;
          else if (isAsciiWord(normalized) && normalized.length === 1) seen.singleAscii += 1;
          else if (isAsciiWord(normalized)) seen.asciiPart += 1;
          else if (knowledgeQueryTerms(normalized).length === 0) seen.symbolsOnly += 1;
        }
        const { scorePermille, keywordHits } = scoreKnowledgeEntry(generated.question, candidate);
        assert.equal(scorePermille, 0, `score ${scorePermille} for question ${JSON.stringify(generated.question)} and entry ${JSON.stringify(candidate)}`);
        assert.equal(keywordHits, 0, `keywordHits ${keywordHits} for question ${JSON.stringify(generated.question)} and entry ${JSON.stringify(candidate)}`);
      }),
      { seed: 10601, numRuns: 2000 }
    );
    // The premise must select plenty of samples, and the generator must reach each substring keyword shape.
    assert.ok(seen.disjoint >= 100, `only ${seen.disjoint} disjoint samples`);
    assert.ok(seen.overlapping >= 100, `only ${seen.overlapping} overlapping samples`);
    for (const shape of ["singleCjk", "asciiPart", "singleAscii", "symbolsOnly"]) assert.ok(seen[shape] >= 10, `only ${seen[shape]} disjoint samples with a ${shape} keyword that is a question substring`);
  });

  test("an entry whose question, alias or keyword shares a search term with the question can score above 0", () => {
    const unrelated = { question: "完全不同的问题内容", aliasQuestions: [], keywords: [] };
    const asked = "什么时候发货";
    const viaQuestion = { ...unrelated, question: "发货时间" };
    const viaAlias = { ...unrelated, aliasQuestions: ["几天发货"] };
    const viaKeyword = { ...unrelated, keywords: ["发货"] };
    for (const [name, candidate] of [["question", viaQuestion], ["alias", viaAlias], ["keyword", viaKeyword]]) {
      assert.ok(knowledgeSearchTerms(candidate).some((term) => knowledgeQueryTerms(asked).includes(term)), `${name} shares a term`);
      assert.ok(scoreKnowledgeEntry(asked, candidate).scorePermille > 0, `${name} scores above 0`);
    }
    assert.equal(scoreKnowledgeEntry(asked, unrelated).scorePermille, 0);
  });
});

describe("worker FAQ rules", () => {
  const tenantId = "10000000-0000-4000-8000-000000000091";
  const run = { id: "10000000-0000-4000-8000-000000000092", tenant_id: tenantId, show_revision_id: "10000000-0000-4000-8000-000000000093", trace_id: "knowledge-test", runtime_session_id: "knowledge-session", pending_program_transition_event_id: null, pending_media_event_id: null, scheduled_start_event_id: null, now_epoch: 1200 };
  const approvalId = "20000000-0000-4000-8000-000000000001";
  const entryId = "20000000-0000-4000-8000-000000000002";
  const comment = (overrides = {}) => ({ id: "20000000-0000-4000-8000-000000000003", interaction_kind: "comment", question_text: "什么时候发货", policy_action: "answer", viewer_ref: null, viewer_nickname: "小明", gift_value_cents: null, channel_connection_id: "20000000-0000-4000-8000-000000000004", ...overrides });
  const faqRule = (overrides = {}) => ({ id: "20000000-0000-4000-8000-000000000005", name: "FAQ", trigger_type: "faq", match_config: { minScorePermille: 600 }, templates: ["{faq_answer}"], action: "reply_draft", cooldown_seconds: 30, interval_seconds: null, priority: 50, default_key: "faq_answer", ...overrides });
  const keywordRule = (overrides = {}) => ({ id: "20000000-0000-4000-8000-000000000006", name: "Keyword", trigger_type: "keyword", match_config: { keywords: ["发货"] }, templates: ["关键词答复"], action: "reply_draft", cooldown_seconds: 30, interval_seconds: null, priority: 100, default_key: null, ...overrides });
  const knowledgeCandidate = (overrides = {}) => ({ approval_id: approvalId, entry_id: entryId, revision: 2, question: "什么时候发货", alias_questions: [], answer: "付款后尽快发货。", keywords: ["发货"], search_terms: ["发货", "时候", "时发", "什么"], answer_sha256: "a".repeat(64), ...overrides });

  async function evaluateWorker({ rules, interactions = [comment()], candidates = [knowledgeCandidate()], lookupError = false, draftExists = false, terms = [], cooledRuleIds = [] }) {
    const queries = [];
    const logs = [];
    const product = { product_name: "洁面商品", price_cent: 9900, product_version_id: "20000000-0000-4000-8000-000000000010", product_revision: 1, source_ref: "evidence://worker-test", source_synced_at: new Date().toISOString(), valid_from: new Date(Date.now() - 60_000).toISOString(), valid_until: null };
    const client = {
      async query(text, params = []) {
        const sql = text.replace(/\s+/g, " ").trim();
        queries.push({ sql, params });
        if (sql.startsWith("select r.id from live_runs r")) return { rows: [{ id: run.id }] };
        if (sql.startsWith("select id, tenant_id, show_revision_id, trace_id")) return { rows: [run] };
        if (sql.startsWith("select id, name, trigger_type")) return { rows: [...rules].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)) };
        if (sql.startsWith("select id, interaction_kind")) return { rows: interactions };
        if (sql.startsWith("select approval_id, entry_id, revision")) {
          if (lookupError) throw new Error("candidate lookup failed");
          return { rows: candidates };
        }
        if (sql.startsWith("select lexicon from show_revision_prohibited_term_snapshots")) return { rows: [] };
        if (sql.startsWith("select tenant_id, kind, builtin_term_id, term, normalized_term, category, approved_revision")) return { rows: terms };
        if (sql.includes("from show_revision_policy_profiles binding")) return { rows: [{ rules: [], evidence_ref: "evidence://worker-test/policy", validation_summary: "approved fixture", approval_status: "approved" }] };
        if (sql.includes("interaction_rule_product_context")) return { rows: [product] };
        if (sql.startsWith("select asset.runtime_voice_id")) return { rows: [{ runtime_voice_id: "worker_test_voice", checksum: `sha256:${"a".repeat(64)}` }] };
        if (sql.startsWith("select template_index")) return { rows: cooledRuleIds.includes(params[1]) ? [{ template_index: 0, age_seconds: 0 }] : [] };
        if (sql.startsWith("select 1 from interaction_rule_firings")) return { rows: [] };
        if (sql.startsWith("select exists (select 1 from outbox_events")) return { rows: [{ pending_speech: false, pending_media: false, last_speech_age_seconds: null }] };
        if (sql.startsWith("insert into outbox_events")) return { rows: [{ id: "20000000-0000-4000-8000-000000000011" }] };
        if (sql.startsWith("insert into channel_reply_drafts")) return { rows: draftExists ? [] : [{ id: "20000000-0000-4000-8000-000000000007" }] };
        if (sql.startsWith("insert into interaction_rule_firings")) {
          if (sql.includes("returning id")) return { rows: [{ id: params[0] }] };
          return { rows: [] };
        }
        if (sql.startsWith("select runtime_worker_actor")) return { rows: [{ id: "20000000-0000-4000-8000-000000000008" }] };
        if (sql.startsWith("insert into audit_events") || sql.startsWith("update live_interactions")) return { rows: [] };
        throw new Error(`unexpected worker FAQ query: ${sql}`);
      }
    };
    const evaluator = interactionRules.createInteractionRuleEvaluator({
      tenantIds: async () => [tenantId],
      inTenantTransaction: async (_tenantId, operation) => operation(client),
      config: { ...interactionRules.interactionRuleConfig({}), viewerCooldownSeconds: 0 },
      maxOutboxAttempts: 6,
      log: (event, fields) => logs.push({ event, fields })
    });
    const summary = await evaluator.runOnce();
    return { summary, queries, logs };
  }

  test("keyword outranks the default FAQ rule, while an explicitly higher FAQ rule renders its answer", async () => {
    const lowerFaq = await evaluateWorker({ rules: [keywordRule(), faqRule()] });
    assert.equal(lowerFaq.summary.replyDrafted, 1);
    assert.equal(lowerFaq.queries.find((query) => query.sql.startsWith("insert into channel_reply_drafts")).params[4], "关键词答复");
    const higherFaq = await evaluateWorker({ rules: [keywordRule(), faqRule({ priority: 200 })] });
    const draft = higherFaq.queries.find((query) => query.sql.startsWith("insert into channel_reply_drafts"));
    assert.equal(draft.params[4], "付款后尽快发货。");
    const evidence = JSON.parse(draft.params[6]);
    assert.deepEqual(evidence[1], { type: "knowledge_entry", approvalId, entryId, revision: 2, answerSha256: "a".repeat(64), scorePermille: 900 });
    const firing = higherFaq.queries.find((query) => query.sql.startsWith("insert into interaction_rule_firings") && !query.sql.includes("returning id"));
    assert.match(firing.sql, /knowledge_approval_id/);
    assert.equal(firing.params.at(-1), approvalId);
  });

  test("ambiguous FAQ is suppressed, but a matching keyword rule remains eligible", async () => {
    const ambiguous = await evaluateWorker({ rules: [faqRule()], candidates: [knowledgeCandidate(), knowledgeCandidate({ entry_id: "20000000-0000-4000-8000-000000000009" })] });
    const firing = ambiguous.queries.find((query) => query.sql.startsWith("insert into interaction_rule_firings") && query.sql.includes("returning id"));
    assert.equal(firing.params[9], "suppressed");
    assert.equal(firing.params[10], "faq_ambiguous");
    const fallback = await evaluateWorker({ rules: [faqRule({ priority: 200 }), keywordRule()], candidates: [knowledgeCandidate(), knowledgeCandidate({ entry_id: "20000000-0000-4000-8000-000000000009" })] });
    assert.equal(fallback.summary.replyDrafted, 1);
    assert.equal(fallback.queries.find((query) => query.sql.startsWith("insert into channel_reply_drafts")).params[4], "关键词答复");
    const cooledKeyword = await evaluateWorker({ rules: [faqRule({ priority: 200 }), keywordRule()], candidates: [knowledgeCandidate(), knowledgeCandidate({ entry_id: "20000000-0000-4000-8000-000000000009" })], cooledRuleIds: [keywordRule().id] });
    const cooledFiring = cooledKeyword.queries.find((query) => query.sql.startsWith("insert into interaction_rule_firings") && query.sql.includes("returning id"));
    assert.equal(cooledFiring.params[2], faqRule().id);
    assert.equal(cooledFiring.params[10], "faq_ambiguous");
  });

  test("lookup errors disable FAQ only; malformed rows, draft conflicts and blocked answers are recorded", async () => {
    const failed = await evaluateWorker({ rules: [faqRule(), keywordRule()], lookupError: true });
    assert.equal(failed.summary.replyDrafted, 1);
    assert.ok(failed.logs.some((item) => item.event === "interaction_rules.knowledge_lookup_failed"));
    const malformed = await evaluateWorker({ rules: [faqRule()], candidates: [knowledgeCandidate({ answer_sha256: "bad" })] });
    assert.equal(malformed.summary.replyDrafted, 0);
    assert.equal(malformed.queries.some((query) => query.sql.startsWith("insert into interaction_rule_firings") && query.params[9] === "suppressed"), false);
    const duplicate = await evaluateWorker({ rules: [faqRule()], draftExists: true });
    const duplicateFiring = duplicate.queries.find((query) => query.sql.startsWith("insert into interaction_rule_firings") && query.sql.includes("returning id"));
    assert.equal(duplicateFiring.params[9], "suppressed");
    assert.equal(duplicateFiring.params[10], "reply_draft_exists");
    const blocked = await evaluateWorker({ rules: [faqRule({ priority: 200 })], terms: [{ kind: "custom", term: "尽快发货", normalized_term: "尽快发货", category: "custom", approved_revision: 1, severity: "block", suggestions: [], disabled: false, active: true }] });
    const blockedFiring = blocked.queries.find((query) => query.sql.startsWith("insert into interaction_rule_firings") && query.sql.includes("returning id"));
    assert.ok(blockedFiring, JSON.stringify({ summary: blocked.summary, logs: blocked.logs, queries: blocked.queries.map((query) => query.sql) }));
    assert.equal(blockedFiring.params[9], "policy_blocked");
    assert.match(blockedFiring.params[10], /^lexicon:|^policy:/);
    assert.equal(blockedFiring.params.at(-1), approvalId);
  });

  test("FAQ candidates are queried only for answerable comments with an FAQ rule", async () => {
    for (const scenario of [
      { rules: [keywordRule()], interactions: [comment()] },
      { rules: [faqRule()], interactions: [comment({ interaction_kind: "follow" })] },
      { rules: [faqRule()], interactions: [comment({ policy_action: "human_review" })] }
    ]) {
      const result = await evaluateWorker(scenario);
      assert.equal(result.queries.some((query) => query.sql.startsWith("select approval_id, entry_id")), false);
    }
  });

  test("FAQ rule and template shape rejects invalid thresholds and slots", () => {
    const parse = (overrides = {}) => interactionRules.parseRule(faqRule(overrides));
    for (const threshold of [undefined, 299, 1001, 600.5]) assert.equal(parse({ match_config: { minScorePermille: threshold } }), null);
    for (const templates of [["answer"], ["{faq_answer}{faq_answer}"], ["{faq_answer}{price}"]]) assert.equal(parse({ templates }), null);
    assert.equal(interactionRules.parseRule({ ...keywordRule(), templates: ["{faq_answer}"] }), null);
    assert.equal(parse().minScorePermille, 600);
    assert.deepEqual(interactionRules.renderTemplate("{faq_answer}", { faq_answer: "答案中保留 {price}" }), { text: "答案中保留 {price}", missing: [] });
  });

  test("Property 14: one comment produces at most one automatic answer from the highest-priority eligible rule", async () => {
    const ruleSpec = fc.record({ priority: fc.integer({ min: 0, max: 1000 }), cooled: fc.boolean(), action: fc.constantFrom("reply_draft", "speak") });
    const extraSpec = fc.record({ triggerType: fc.constantFrom("keyword", "faq"), priority: fc.integer({ min: 0, max: 1000 }), cooled: fc.boolean(), action: fc.constantFrom("reply_draft", "speak") });
    const generated = fc.tuple(ruleSpec, ruleSpec, fc.array(extraSpec, { maxLength: 6 }))
      .map(([keyword, faq, rest]) => [{ triggerType: "keyword", ...keyword }, { triggerType: "faq", ...faq }, ...rest]);
    const scenario = fc.oneof(
      generated,
      fc.constant([{ triggerType: "keyword", priority: 500, cooled: false, action: "reply_draft" }, { triggerType: "faq", priority: 500, cooled: false, action: "speak" }]),
      fc.constant([{ triggerType: "keyword", priority: 200, cooled: true, action: "speak" }, { triggerType: "faq", priority: 100, cooled: true, action: "reply_draft" }]),
      fc.constant([{ triggerType: "keyword", priority: 500, cooled: false, action: "speak" }, { triggerType: "faq", priority: 100, cooled: false, action: "reply_draft" }]),
      fc.constant([{ triggerType: "keyword", priority: 100, cooled: true, action: "speak" }, { triggerType: "faq", priority: 500, cooled: false, action: "reply_draft" }])
    );
    const seen = { highestTie: 0, allCooled: 0, speech: 0, draft: 0 };
    await fc.assert(fc.asyncProperty(scenario, async (specs) => {
        const generatedRules = specs.map((spec, index) => ({
          id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          name: `rule-${index}`,
          trigger_type: spec.triggerType,
          match_config: spec.triggerType === "faq" ? { minScorePermille: 300 + (spec.priority % 701) } : { keywords: ["发货"] },
          templates: spec.triggerType === "faq" ? ["{faq_answer}"] : ["关键词答复"],
          action: spec.action,
          cooldown_seconds: 30,
          interval_seconds: null,
          priority: spec.priority,
          default_key: null,
          cooled: spec.cooled
        }));
        const rules = generatedRules.map(({ cooled, ...row }) => row);
        const cooledRuleIds = generatedRules.filter((rule) => rule.cooled).map((rule) => rule.id);
        const candidates = [knowledgeCandidate({ keywords: ["发货", "什么时候发货"] })];
        const result = await evaluateWorker({ rules, candidates, cooledRuleIds });
        const firingQueries = result.queries.filter((query) => query.sql.startsWith("insert into interaction_rule_firings"));
        const successes = firingQueries.filter((query) => !query.sql.includes("returning id") && ["speech_queued", "reply_drafted"].includes(query.params[9]));
        assert.ok(successes.length <= 1, "one comment has at most one successful automatic answer");
        const expected = [...generatedRules].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)).find((rule) => !rule.cooled);
        if (expected) {
          if (generatedRules.filter((rule) => !rule.cooled && rule.priority === expected.priority).length > 1) seen.highestTie += 1;
          assert.equal(successes.length, 1);
          assert.equal(successes[0].params[2], expected.id);
          assert.equal(successes[0].params[9], expected.action === "speak" ? "speech_queued" : "reply_drafted");
          assert.equal(result.summary.speechQueued + result.summary.replyDrafted, 1);
          seen[expected.action === "speak" ? "speech" : "draft"] += 1;
        } else {
          seen.allCooled += 1;
          assert.equal(successes.length, 0);
          assert.equal(result.summary.speechQueued + result.summary.replyDrafted, 0);
          const suppressed = firingQueries.find((query) => query.sql.includes("returning id"));
          const highest = [...generatedRules].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
          assert.equal(suppressed.params[2], highest.id);
          assert.equal(suppressed.params[9], "suppressed");
          assert.equal(suppressed.params[10], "rule_cooldown");
        }
      }), { seed: 11014, numRuns: 100 });
    for (const branch of Object.keys(seen)) assert.ok(seen[branch] > 0, `Property 14 did not exercise ${branch}`);
  });
});

describe("plain-text knowledge document import", () => {
  test("imports pending searchable chunks, lists documents, and enforces role and input limits", async () => {
    const tenantId = "tenant_knowledge_documents_demo";
    const body = "退货规则是什么？支持七天内申请退货。\n\n发货规则是什么？订单通常在二十四小时内发货。";
    const post = (input, role = "operator") => callKnowledgeRoute(knowledgeDocumentsRoute.POST, "/api/v1/knowledge-documents", { method: "POST", role, tenantId, actorId: `kb-document-${role}`, body: input });
    assert.equal((await knowledgeDocumentsRoute.GET(new Request("http://127.0.0.1/api/v1/knowledge-documents", { headers: knowledgeHeaders("admin", "kb-document-admin", tenantId) }))).status, 200);
    assert.equal((await post({ title: "规则文档", sourceRef: "evidence://handbook/returns", body }, "reviewer")).status, 403);
    assert.equal((await post({ title: "规则文档", sourceRef: "evidence://handbook/returns", body }, "analyst")).status, 403);
    assert.equal((await post({ title: "规则文档", sourceRef: "https://example.invalid/doc", body })).status, 400);
    assert.equal((await post({ title: "管理员导入", sourceRef: "evidence://handbook/admin", body }, "admin")).status, 201);

    const imported = await post({ title: "售后与发货规则", sourceRef: "urn:handbook:returns-v1", body });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.data.document.title, "售后与发货规则");
    assert.equal(imported.body.data.document.sourceRef, "urn:handbook:returns-v1");
    assert.match(imported.body.data.document.bodySha256, /^[0-9a-f]{64}$/);
    assert.equal(imported.body.data.document.chunkCount, imported.body.data.created.length);
    assert.ok(imported.body.data.created.length > 0);
    assert.ok(imported.body.data.created.every((entry) => entry.kind === "document_chunk" && entry.status === "pending" && !entry.keywords.length));

    const listed = await callKnowledgeRoute(knowledgeDocumentsRoute.GET, "/api/v1/knowledge-documents", { role: "analyst", actorId: "kb-document-analyst", tenantId });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.some((document) => document.id === imported.body.data.document.id));
    const preview = await callKnowledgeRoute(knowledgeRoutes.search.POST, "/api/v1/knowledge-entries/search", { method: "POST", role: "analyst", actorId: "kb-document-reader", tenantId, body: { question: imported.body.data.created[0].question } });
    assert.equal(preview.body.data.reason, "no_candidates", "pending imported chunks must not enter search");

    const context = { tenantId, actorId: "kb-document-admin", actorName: "Admin", role: "admin" };
    const beforeDocuments = (await knowledgeService.listKnowledgeDocuments(context)).length;
    const beforeEntries = (await knowledgeService.listKnowledgeEntries(context)).length;
    assert.equal((await post({ title: "超长正文", sourceRef: "evidence://handbook/oversized", body: "退".repeat(50_001) })).status, 400);
    assert.equal((await post({ title: "超多片段", sourceRef: "evidence://handbook/chunks", body: Array.from({ length: 201 }, (_, index) => `规则${index}。`).join("\n\n") })).status, 400);
    assert.equal((await knowledgeService.listKnowledgeDocuments(context)).length, beforeDocuments);
    assert.equal((await knowledgeService.listKnowledgeEntries(context)).length, beforeEntries);

    const audit = globalThis.shuzhirenAuditStore.events.find((event) => event.resourceId === imported.body.data.document.id);
    assert.equal(audit.type, "knowledge_document.imported");
    assert.equal(audit.detail.bodySha256, imported.body.data.document.bodySha256);
    assert.equal(audit.detail.chunkCount, imported.body.data.document.chunkCount);
  });
});
