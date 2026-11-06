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
