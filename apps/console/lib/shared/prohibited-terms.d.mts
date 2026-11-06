export type LexiconCategory = "extreme" | "medical" | "false_claim" | "offsite_trade" | "custom";
export type LexiconSeverity = "block" | "warn";
/** A compiled lexicon entry; `normalized === normalizePolicyText(term)` and is never empty. */
export type LexiconTerm = { id: string; term: string; normalized: string; category: LexiconCategory; severity: LexiconSeverity; suggestions: string[] };
/** An uncompiled entry (the built-in list, or what compileLexicon accepts). */
export type RawLexiconTerm = { id: string; term: string; category: LexiconCategory; severity: LexiconSeverity; suggestions?: readonly string[] };
export type Finding = { termId: string; term: string; category: LexiconCategory; severity: LexiconSeverity; start: number; end: number; matchedText: string; suggestions: string[] };
/** The columns of tenant_prohibited_terms that effectiveLexicon reads; rows with no approved_revision have no effect. */
export type TenantTermRow = {
  kind: "custom" | "builtin_override";
  builtin_term_id?: string | null;
  term?: string | null;
  category?: string | null;
  approved_revision?: number | null;
  severity?: LexiconSeverity | null;
  /** An array, or its JSON text; null keeps the built-in suggestions. */
  suggestions?: unknown;
  disabled?: boolean;
  active?: boolean;
};
export type ScanText = {
  /** Always equal to normalizePolicyText(text). */
  normalized: string;
  /** For each UTF-16 unit of `normalized`, the start and end offsets in the original text of the cluster that produced it. */
  starts: number[];
  ends: number[];
  /** False when the mapping is unreliable and every unit maps to the whole text. */
  exact: boolean;
};
export declare function normalizeForScan(text: string): ScanText;
export declare function scanProhibitedTerms(text: string, lexicon: readonly LexiconTerm[]): Finding[];
export declare function applySuggestion(text: string, finding: Pick<Finding, "start" | "end" | "matchedText">, suggestion: string): string;
export declare function compileLexicon(terms: readonly RawLexiconTerm[]): LexiconTerm[];
export declare function effectiveLexicon(builtin: readonly RawLexiconTerm[], tenantRows: readonly TenantTermRow[]): LexiconTerm[];
export declare function runtimeLexicon(frozen: readonly LexiconTerm[] | null, current: readonly LexiconTerm[]): LexiconTerm[];
export declare function lexiconSha256(lexicon: readonly LexiconTerm[]): string;
/** Why `term` cannot be a lexicon term, or null when it can. */
export declare function termProblem(term: unknown): string | null;
