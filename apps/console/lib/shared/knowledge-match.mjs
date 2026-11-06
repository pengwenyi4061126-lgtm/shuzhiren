// Knowledge base matching shared by the console and the runtime worker (design.md module D, K2).
// Pure functions: application-side tokenization (CJK bigrams plus ASCII words) feeds a text[] GIN index,
// and candidates are scored here, so the console and the worker rank identically.
import { normalizePolicyText } from "./policy-engine.mjs";

const MAX_NORMALIZE_PASSES = 8;
const MAX_SEARCH_TERMS = 2000;
const DEFAULT_AMBIGUITY_MARGIN_PERMILLE = 50;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_ALNUM = /[a-z0-9]/;

/**
 * normalizePolicyText applied until the result stops changing (at most 8 passes). A single pass is not
 * idempotent: NFKC runs before zero-width characters are removed, and the removal can leave characters that
 * NFKC would compose (e, U+200B, U+0301).
 */
function normalizeStable(text) {
  let current = normalizePolicyText(String(text ?? ""));
  for (let pass = 1; pass < MAX_NORMALIZE_PASSES; pass += 1) {
    const next = normalizePolicyText(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function tokenize(normalized) {
  const terms = new Set();
  let cjkRun = [];
  let asciiRun = "";
  const flushCjk = () => {
    if (cjkRun.length === 1) terms.add(cjkRun[0]);
    for (let index = 0; index + 1 < cjkRun.length; index += 1) terms.add(cjkRun[index] + cjkRun[index + 1]);
    cjkRun = [];
  };
  const flushAscii = () => {
    if (asciiRun.length >= 2) terms.add(asciiRun);
    asciiRun = "";
  };
  for (const char of normalized) {
    if (CJK.test(char)) {
      flushAscii();
      cjkRun.push(char);
    } else if (ASCII_ALNUM.test(char)) {
      flushCjk();
      asciiRun += char;
    } else {
      flushCjk();
      flushAscii();
    }
  }
  flushCjk();
  flushAscii();
  return terms;
}

const sortedTerms = (terms) => [...terms].sort();

/** Sorted, de-duplicated search terms of a text: CJK bigrams (a lone CJK character is itself a term) and ASCII alphanumeric words of length >= 2. */
export function knowledgeQueryTerms(text) {
  return sortedTerms(tokenize(normalizeStable(text)));
}

/** Union of the terms of the question, alias questions and keywords (never the answer), sorted and capped at 2000. */
export function knowledgeSearchTerms(entry) {
  const union = new Set();
  const texts = [entry.question, ...(entry.aliasQuestions ?? []), ...(entry.keywords ?? [])];
  for (const text of texts) for (const term of tokenize(normalizeStable(text))) union.add(term);
  return sortedTerms(union).slice(0, MAX_SEARCH_TERMS);
}

function diceCoefficient(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** Score of one entry for a question, 0-1000. A keyword contained in the question scores at least 600. */
export function scoreKnowledgeEntry(question, entry) {
  const normalizedQuestion = normalizeStable(question);
  const questionTerms = tokenize(normalizedQuestion);
  let keywordHits = 0;
  for (const keyword of entry.keywords ?? []) {
    const normalizedKeyword = normalizeStable(keyword);
    if (normalizedKeyword.length > 0 && normalizedQuestion.includes(normalizedKeyword)) keywordHits += 1;
  }
  let dice = 0;
  for (const text of [entry.question, ...(entry.aliasQuestions ?? [])]) {
    dice = Math.max(dice, diceCoefficient(questionTerms, tokenize(normalizeStable(text))));
  }
  const scorePermille = keywordHits > 0 ? Math.min(1000, 600 + 100 * (keywordHits - 1) + Math.round(300 * dice)) : Math.round(1000 * dice);
  return { scorePermille, keywordHits };
}

const compareRanked = (a, b) =>
  b.scorePermille - a.scorePermille || b.keywordHits - a.keywordHits || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);

/**
 * The best candidate for a question. Ordered by score, keyword hits, then entryId, so the result does not
 * depend on the candidate order. below_threshold: the best score is under minScorePermille; ambiguous: another
 * entry is within ambiguityMarginPermille (default 50) of the best; no_candidates: the list is empty.
 */
export function rankKnowledgeHits(question, candidates, options) {
  if (candidates.length === 0) return { hit: null, reason: "no_candidates" };
  const margin = options.ambiguityMarginPermille ?? DEFAULT_AMBIGUITY_MARGIN_PERMILLE;
  const ranked = candidates.map((candidate) => ({ ...candidate, ...scoreKnowledgeEntry(question, candidate) })).sort(compareRanked);
  const [best] = ranked;
  if (best.scorePermille < options.minScorePermille) return { hit: null, reason: "below_threshold" };
  const second = ranked.find((candidate) => candidate.entryId !== best.entryId);
  if (second && best.scorePermille - second.scorePermille < margin) return { hit: null, reason: "ambiguous" };
  return { hit: best, reason: "matched" };
}
