import type { PolicyDecision, PolicyRule } from "./policy-engine.mjs";
import type { Finding, LexiconTerm } from "./prohibited-terms.mjs";

export type BroadcastGuardOptions = {
  policyRules: PolicyRule[];
  lexicon: readonly LexiconTerm[];
  /** A positive integer; longer text is not allowed. */
  maxLength: number;
  /** Defaults to ["product_version"]. */
  evidenceIds?: string[];
};
export type BroadcastGuardResult = { allowed: boolean; decision: PolicyDecision; findings: Finding[]; reasons: string[] };
export declare function guardBroadcastText(text: string, options: BroadcastGuardOptions): BroadcastGuardResult;
