// The pre-broadcast check (design.md module E, E.3): one function that every place which is about to speak or show
// text calls. It combines the policy engine (rules of the bound policy profile) with the prohibited-term lexicon.
// Pure: no I/O, no side effects. Imports only sibling .mjs files; keep broadcast-guard.d.mts in step.
import { evaluatePolicy } from "./policy-engine.mjs";
import { scanProhibitedTerms } from "./prohibited-terms.mjs";

const MAX_SCAN_LENGTH = 2000;

/**
 * allowed is true only when the text is not blank, is at most maxLength characters, contains no `block` term and the
 * policy engine decides `answer` (evidence defaults to ["product_version"]). `warn` terms appear in `findings` but never
 * block. `reasons` holds the policy reasons followed by `lexicon:<category>:<termId>` for each blocking term.
 * Throws RangeError when maxLength is not a positive integer (a programming error, not a property of the text).
 */
export function guardBroadcastText(text, options) {
  const { policyRules, lexicon, maxLength, evidenceIds } = options;
  if (!Number.isInteger(maxLength) || maxLength <= 0) throw new RangeError("maxLength must be a positive integer");
  const value = typeof text === "string" ? text : "";
  const reasons = [];
  const blank = value.trim().length === 0;
  const tooLong = value.length > maxLength;
  if (blank) reasons.push("话术为空");
  if (tooLong) reasons.push(`话术超过 ${maxLength} 字符上限`);
  const decision = evaluatePolicy(value, evidenceIds ?? ["product_version"], policyRules ?? []);
  reasons.push(...decision.reasons);
  // Text longer than the scan limit is rejected above anyway, so it is not scanned.
  const findings = value.length <= MAX_SCAN_LENGTH ? scanProhibitedTerms(value, lexicon ?? []) : [];
  for (const finding of findings) {
    const reason = `lexicon:${finding.category}:${finding.termId}`;
    if (finding.severity === "block" && !reasons.includes(reason)) reasons.push(reason);
  }
  const blocked = findings.some((finding) => finding.severity === "block");
  return { allowed: !blank && !tooLong && !blocked && decision.action === "answer", decision, findings, reasons };
}
