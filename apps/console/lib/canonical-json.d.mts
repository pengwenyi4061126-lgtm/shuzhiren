export type CanonicalJsonRuleVersion = 1 | 2;
export declare const CANONICAL_JSON_RULE_VERSION: 2;
export declare const CANONICAL_JSON_RULE_VERSIONS: readonly CanonicalJsonRuleVersion[];
export declare class CanonicalJsonError extends TypeError {
  readonly path: string;
  constructor(message: string, path: string);
}
export declare function isCanonicalJsonRuleVersion(value: unknown): value is CanonicalJsonRuleVersion;
export declare function compareCodePoints(left: string, right: string): -1 | 0 | 1;
export declare function canonicalJson(value: unknown, options?: { ruleVersion?: CanonicalJsonRuleVersion }): string;
