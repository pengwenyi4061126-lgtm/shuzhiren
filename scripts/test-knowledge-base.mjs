// Unit tests of the knowledge base matching (design.md module D): tokenization, scoring and ranking in
// apps/console/lib/shared/knowledge-match.mjs, which the console and the runtime worker both run.
// No database is involved.
//
//   node --test scripts/test-knowledge-base.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import { normalizePolicyText } from "../apps/console/lib/shared/policy-engine.mjs";
import { knowledgeQueryTerms, knowledgeSearchTerms, rankKnowledgeHits, scoreKnowledgeEntry } from "../apps/console/lib/shared/knowledge-match.mjs";
register("./lib/console-ts-loader.mjs", import.meta.url);

const entry = (overrides = {}) => ({ entryId: "00000000-0000-4000-8000-000000000001", question: "什么时候发货", aliasQuestions: [], keywords: ["发货"], ...overrides });

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
  test("a keyword contained in the question scores at least 600", () => {
    const { scorePermille, keywordHits } = scoreKnowledgeEntry("什么时候发货呀", entry());
    assert.equal(keywordHits, 1);
    assert.equal(scorePermille, 873);
    assert.ok(scoreKnowledgeEntry("发货", entry({ question: "完全不同的问题内容" })).scorePermille >= 600);
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
