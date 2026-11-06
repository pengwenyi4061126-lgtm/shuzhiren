// Prohibited-term scanning shared by the console and the runtime worker (design.md module E, E.1 and E.2).
// Pure functions only: no I/O, no clock, no randomness. It imports only node: built-ins and sibling .mjs files
// (`npm run shared:modules:check` enforces that) and must stay in step with prohibited-terms.d.mts.
//
// Vocabulary: a LexiconTerm is a compiled entry { id, term, normalized, category, severity, suggestions } where
// `normalized === normalizePolicyText(term)`. A Finding is one occurrence of a term in a text, with its [start, end)
// range in the ORIGINAL text, so an editor can highlight it and replace it.
import { createHash } from "node:crypto";
import { normalizePolicyText } from "./policy-engine.mjs";

const CATEGORIES = new Set(["extreme", "medical", "false_claim", "offsite_trade", "custom"]);
const MAX_SUGGESTIONS = 5;
const MAX_TERM_LENGTH = 30;
const markPattern = /^\p{M}/u;

const isCategory = (value) => typeof value === "string" && CATEGORIES.has(value);
const isSeverity = (value) => value === "block" || value === "warn";
/** Unknown or missing severities count as `block`: a malformed entry must never loosen the filter. */
const severityOf = (value) => (value === "warn" ? "warn" : "block");
const severityRank = (term) => (term.severity === "block" ? 1 : 0);
const codePointLength = (text) => [...text].length;

/** Orders by Unicode code point (not UTF-16 code unit), so the order matches Canonical_JSON and UTF-8. */
function compareCodePoints(left, right) {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i);
    const b = right.codePointAt(j);
    if (a !== b) return a < b ? -1 : 1;
    i += a > 0xffff ? 2 : 1;
    j += b > 0xffff ? 2 : 1;
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0;
}

/**
 * normalizePolicyText(text) together with, for every UTF-16 unit of the result, the range of the original text that
 * produced it. The text is cut into clusters (a code point plus the combining marks that follow it) and each cluster
 * is normalized on its own. When the concatenation of the clusters differs from normalizePolicyText(text) (Hangul
 * jamo composition, context-sensitive lower-casing), the mapping is unreliable: `exact` is false and every unit maps
 * to the whole text.
 */
export function normalizeForScan(text) {
  const whole = normalizePolicyText(text);
  const starts = [];
  const ends = [];
  let normalized = "";
  let cluster = "";
  let clusterStart = 0;
  let offset = 0;
  const flush = () => {
    if (cluster === "") return;
    const piece = normalizePolicyText(cluster);
    for (let index = 0; index < piece.length; index += 1) {
      starts.push(clusterStart);
      ends.push(offset);
    }
    normalized += piece;
    cluster = "";
  };
  for (const char of text) {
    if (cluster !== "" && !markPattern.test(char)) flush();
    if (cluster === "") clusterStart = offset;
    cluster += char;
    offset += char.length;
  }
  flush();
  if (normalized === whole) return { normalized, starts, ends, exact: true };
  return { normalized: whole, starts: new Array(whole.length).fill(0), ends: new Array(whole.length).fill(text.length), exact: false };
}

/**
 * Every occurrence of every lexicon term in `text` (overlapping occurrences included), as ranges of the original text.
 * Ordered by start ascending, end descending, termId ascending. Does not modify its inputs.
 */
export function scanProhibitedTerms(text, lexicon) {
  if (typeof text !== "string" || text === "" || !Array.isArray(lexicon)) return [];
  const { normalized, starts, ends } = normalizeForScan(text);
  if (normalized === "") return [];
  const seen = new Set();
  const findings = [];
  for (const entry of lexicon) {
    const needle = entry?.normalized;
    if (typeof needle !== "string" || needle === "") continue;
    for (let at = normalized.indexOf(needle); at !== -1; at = normalized.indexOf(needle, at + 1)) {
      let start = starts[at];
      let end = ends[at + needle.length - 1];
      // The range must itself normalize to something containing the term; otherwise report the whole text.
      if (!normalizePolicyText(text.slice(start, end)).includes(needle)) {
        start = 0;
        end = text.length;
      }
      const key = `${entry.id}\u0000${start}\u0000${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        termId: String(entry.id),
        term: String(entry.term),
        category: entry.category,
        severity: severityOf(entry.severity),
        start,
        end,
        matchedText: text.slice(start, end),
        suggestions: Array.isArray(entry.suggestions) ? entry.suggestions.filter((item) => typeof item === "string") : []
      });
    }
  }
  return findings.sort((a, b) => a.start - b.start || b.end - a.end || compareCodePoints(a.termId, b.termId));
}

/** `text` with the range of `finding` replaced by `suggestion`. Throws RangeError when the finding is stale. */
export function applySuggestion(text, finding, suggestion) {
  if (typeof suggestion !== "string") throw new TypeError("suggestion must be a string");
  if (!Number.isInteger(finding?.start) || !Number.isInteger(finding?.end) || finding.start < 0 || finding.start >= finding.end || finding.end > text.length || text.slice(finding.start, finding.end) !== finding.matchedText) {
    throw new RangeError("the finding does not match the text; scan the text again");
  }
  return text.slice(0, finding.start) + suggestion + text.slice(finding.end);
}

function cleanSuggestions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "" && !result.includes(trimmed)) result.push(trimmed);
    if (result.length === MAX_SUGGESTIONS) break;
  }
  return result;
}

/** A compiled LexiconTerm from a raw entry, or null when it has no usable id or term. `normalized` is always recomputed. */
function cleanTerm(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || raw.id === "" || typeof raw.term !== "string") return null;
  const normalized = normalizePolicyText(raw.term);
  if (normalized === "") return null;
  return { id: raw.id, term: raw.term, normalized, category: isCategory(raw.category) ? raw.category : "custom", severity: severityOf(raw.severity), suggestions: cleanSuggestions(raw.suggestions) };
}

const sortTerms = (terms) => terms.sort((a, b) => compareCodePoints(a.normalized, b.normalized) || compareCodePoints(a.id, b.id));

/**
 * Compiles raw entries { id, term, category, severity, suggestions } into a lexicon: normalized form recomputed,
 * unusable entries dropped, one entry per normalized term (the stricter severity wins; on a tie the smaller id), sorted
 * by normalized term. The result does not depend on the order of the input.
 */
export function compileLexicon(terms) {
  const best = new Map();
  const cleaned = (Array.isArray(terms) ? terms : []).map(cleanTerm).filter((term) => term !== null).sort((a, b) => compareCodePoints(a.id, b.id));
  for (const term of cleaned) {
    const current = best.get(term.normalized);
    if (!current || severityRank(term) > severityRank(current)) best.set(term.normalized, term);
  }
  return sortTerms([...best.values()]);
}

function parseSuggestionsValue(value) {
  if (typeof value === "string") {
    try {
      return parseSuggestionsValue(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? cleanSuggestions(value) : null;
}

const isApprovedRow = (row) => row && typeof row === "object" && Number.isInteger(row.approved_revision) && row.approved_revision >= 1;

/**
 * The lexicon in force for a tenant: the built-in terms minus approved disabling overrides, with approved severity and
 * suggestion overrides applied, plus approved and active custom terms. Rows without an approved revision have no effect.
 * Rows have the shape of tenant_prohibited_terms; a custom term gets the id `custom:<normalized>` because the worker is
 * not granted the row id.
 */
export function effectiveLexicon(builtin, tenantRows) {
  const rows = Array.isArray(tenantRows) ? tenantRows.filter(isApprovedRow) : [];
  const overrides = new Map();
  for (const row of rows) {
    if (row.kind !== "builtin_override" || typeof row.builtin_term_id !== "string") continue;
    const previous = overrides.get(row.builtin_term_id);
    if (!previous || row.approved_revision > previous.approved_revision) overrides.set(row.builtin_term_id, row);
  }
  const terms = [];
  for (const entry of Array.isArray(builtin) ? builtin : []) {
    if (!entry || typeof entry !== "object") continue;
    const override = overrides.get(entry.id);
    if (override?.disabled === true) continue;
    const suggestions = override ? parseSuggestionsValue(override.suggestions) : null;
    terms.push({ ...entry, severity: override && isSeverity(override.severity) ? override.severity : entry.severity, suggestions: suggestions ?? entry.suggestions });
  }
  for (const row of rows) {
    if (row.kind !== "custom" || row.active === false || termProblem(row.term) !== null) continue;
    terms.push({
      id: `custom:${normalizePolicyText(row.term)}`,
      term: row.term.trim(),
      category: isCategory(row.category) ? row.category : "custom",
      severity: isSeverity(row.severity) ? row.severity : "block",
      suggestions: parseSuggestionsValue(row.suggestions) ?? []
    });
  }
  return compileLexicon(terms);
}

/**
 * snapshot ∪ current, one entry per normalized term. The stricter severity wins (on a tie the frozen entry), the
 * entry that wins supplies id, term and category, and the suggestions are the frozen ones when the term is frozen.
 * `frozen === null` (a revision without a snapshot) yields the compiled `current`.
 */
export function runtimeLexicon(frozen, current) {
  const merged = new Map(compileLexicon(current).map((term) => [term.normalized, term]));
  if (frozen === null || frozen === undefined) return sortTerms([...merged.values()]);
  for (const term of compileLexicon(frozen)) {
    const live = merged.get(term.normalized);
    if (!live) merged.set(term.normalized, term);
    else merged.set(term.normalized, { ...(severityRank(live) > severityRank(term) ? live : term), suggestions: [...term.suggestions] });
  }
  return sortTerms([...merged.values()]);
}

/**
 * Lower-case hex SHA-256 of the lexicon's canonical form: terms sorted by normalized term, keys in alphabetical order,
 * no whitespace. For a compiled lexicon this equals sha256(canonicalJson(lexicon)) in lib/canonical-json.mjs, which this
 * directory may not import.
 */
export function lexiconSha256(lexicon) {
  const terms = sortTerms((Array.isArray(lexicon) ? lexicon : []).map(cleanTerm).filter((term) => term !== null));
  const text = (value) => JSON.stringify(value);
  const body = terms.map((term) => `{"category":${text(term.category)},"id":${text(term.id)},"normalized":${text(term.normalized)},"severity":${text(term.severity)},"suggestions":[${term.suggestions.map(text).join(",")}],"term":${text(term.term)}}`).join(",");
  return createHash("sha256").update(`[${body}]`, "utf8").digest("hex");
}

/** Why `term` cannot be a lexicon term (a Chinese message), or null when it can: 1 to 30 characters after trimming, and not empty once normalized. */
export function termProblem(term) {
  if (typeof term !== "string") return "违禁词必须是文本";
  const trimmed = term.trim();
  if (trimmed === "") return "违禁词不能为空或只含空白";
  if (codePointLength(trimmed) > MAX_TERM_LENGTH) return `违禁词不能超过 ${MAX_TERM_LENGTH} 个字符`;
  const normalized = normalizePolicyText(term);
  if (normalized === "") return "违禁词规范化后为空（只含空白或零宽字符）";
  if (codePointLength(normalized) > MAX_TERM_LENGTH) return `违禁词规范化后不能超过 ${MAX_TERM_LENGTH} 个字符`;
  return null;
}
