// Unit tests of the knowledge base matching (design.md module D): tokenization, scoring and ranking in
// apps/console/lib/shared/knowledge-match.mjs, which the console and the runtime worker both run.
// No database is involved.
//
//   node --test scripts/test-knowledge-base.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, test } from "node:test";
import fc from "fast-check";
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

  test("an entry with a keyword that is a substring of the normalized question scores at least 600", () => {
    const questionWithText = text.filter((value) => normalizeStable(value).length > 0);
    const substring = fc.record({ start: fc.nat(), length: fc.oneof({ weight: 3, arbitrary: fc.constant(1) }, { weight: 3, arbitrary: fc.integer({ min: 1, max: 4 }) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 64 }) }) });
    fc.assert(
      fc.property(
        questionWithText,
        fc.array(text, { maxLength: 5 }),
        text,
        fc.array(substring, { minLength: 1, maxLength: 20 }),
        fc.array(text, { maxLength: 3 }),
        (question, aliasQuestions, entryQuestion, picks, noiseKeywords) => {
          const normalized = Array.from(normalizeStable(question));
          const keywords = picks.map(({ start, length }) => {
            const from = start % normalized.length;
            return normalized.slice(from, from + length).join("");
          });
          const { scorePermille, keywordHits } = scoreKnowledgeEntry(question, { question: entryQuestion, aliasQuestions, keywords: [...noiseKeywords, ...keywords] });
          assert.ok(keywordHits >= 1, `no keyword hit for ${JSON.stringify(keywords)} in ${JSON.stringify(normalized.join(""))}`);
          assert.ok(scorePermille >= 600 && scorePermille <= 1000, `score ${scorePermille} for keywords ${JSON.stringify(keywords)}`);
        }
      ),
      { seed: 10402, numRuns: 500 }
    );
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
