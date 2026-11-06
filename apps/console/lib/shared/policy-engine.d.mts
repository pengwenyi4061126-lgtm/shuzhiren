export type PolicyDecision = {
  action: "answer" | "handoff" | "refuse";
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  requiredEvidence: string[];
};
export type PolicyRule = { id: string; terms: string[]; reason: string; action: PolicyDecision["action"]; riskLevel: PolicyDecision["riskLevel"]; requiredEvidence: string[] };
export declare const maxPolicyQuestionLength: 1000;
export declare function evaluatePolicy(question: string, evidenceIds: string[], additionalRules?: PolicyRule[]): PolicyDecision;
export declare function isControlledPolicyQuestion(question: string): boolean;
export declare function normalizePolicyText(text: string): string;
export declare function isPolicyRule(value: unknown): value is PolicyRule;
/** The rules of a policy_profiles.rules jsonb value (an array, or its JSON text); anything unparseable yields []. */
export declare function parsePolicyRules(value: unknown): PolicyRule[];