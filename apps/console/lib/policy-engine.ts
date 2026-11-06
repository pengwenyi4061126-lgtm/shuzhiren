// Compatibility re-export: the implementation lives in lib/shared/policy-engine.mjs, which the runtime worker imports too.
export { evaluatePolicy, isControlledPolicyQuestion, maxPolicyQuestionLength } from "@/lib/shared/policy-engine.mjs";
export type { PolicyDecision, PolicyRule } from "@/lib/shared/policy-engine.mjs";