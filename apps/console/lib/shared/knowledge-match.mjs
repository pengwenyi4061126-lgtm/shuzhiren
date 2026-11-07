// Knowledge base matching shared by the console and the runtime worker (design.md module D, K2).
// Pure functions: application-side tokenization (CJK bigrams plus ASCII words) feeds a text[] GIN index,
// and candidates are scored here, so the console and the worker rank identically.
import { normalizePolicyText } from "./policy-engine.mjs";

const MAX_NORMALIZE_PASSES = 8;
const MAX_SEARCH_TERMS = 2000;
const DEFAULT_AMBIGUITY_MARGIN_PERMILLE = 50;
const MAX_DOCUMENT_CHARACTERS = 50_000;
const MAX_DOCUMENT_CHUNK_CHARACTERS = 300;
const MAX_DOCUMENT_CHUNKS = 200;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_ALNUM = /[a-z0-9]/;
const SENTENCE_END = new Set(["。", "！", "？", "!", "?", ".", "；", ";"]);

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

/**
 * Score of one entry for a question, 0-1000. A keyword hits when its search terms are non-empty and all among the
 * question's search terms (token match, not substring match), which keeps scoring consistent with the search_terms
 * overlap prefilter: an entry sharing no search term with the question always scores 0. A hit scores at least 600.
 */
export function scoreKnowledgeEntry(question, entry) {
  const questionTerms = tokenize(normalizeStable(question));
  let keywordHits = 0;
  for (const keyword of entry.keywords ?? []) {
    const keywordTerms = tokenize(normalizeStable(keyword));
    if (keywordTerms.size > 0 && [...keywordTerms].every((term) => questionTerms.has(term))) keywordHits += 1;
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

/** Split a plain-text knowledge document into ordered, non-empty chunks of at most 300 code points. */
export function chunkKnowledgeDocument(body) {
  if (typeof body !== "string") throw Object.assign(new TypeError("document body must be text"), { reason: "invalid_body" });
  if (Array.from(body).length > MAX_DOCUMENT_CHARACTERS) throw Object.assign(new RangeError("document body exceeds 50000 characters"), { reason: "body_too_large" });

  const chunks = [];
  for (const rawParagraph of body.split(/\r?\n[\t ]*\r?\n/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    const chars = Array.from(paragraph);
    const sentences = [];
    let start = 0;
    for (let index = 0; index < chars.length; index += 1) {
      if (!SENTENCE_END.has(chars[index])) continue;
      while (index + 1 < chars.length && SENTENCE_END.has(chars[index + 1])) index += 1;
      const sentence = chars.slice(start, index + 1).join("").trim();
      if (sentence) sentences.push(sentence);
      start = index + 1;
    }
    const tail = chars.slice(start).join("").trim();
    if (tail) sentences.push(tail);

    let current = "";
    const flush = () => { if (current) chunks.push(current); current = ""; };
    for (const sentence of sentences) {
      let remaining = Array.from(sentence);
      while (remaining.length) {
        const separator = current ? " " : "";
        const available = MAX_DOCUMENT_CHUNK_CHARACTERS - Array.from(current).length - Array.from(separator).length;
        if (remaining.length <= available) {
          current += separator + remaining.join("");
          remaining = [];
        } else if (current) {
          flush();
        } else {
          chunks.push(remaining.splice(0, MAX_DOCUMENT_CHUNK_CHARACTERS).join(""));
        }
      }
    }
    flush();
    if (chunks.length > MAX_DOCUMENT_CHUNKS) throw Object.assign(new RangeError("document exceeds 200 chunks"), { reason: "too_many_chunks" });
  }
  return chunks;
}
