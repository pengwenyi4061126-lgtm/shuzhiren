export declare const maxScriptVariants: 4;
export declare const maxScriptLength: 800;
/** The variants of a runtime_script_variants value (an array, or its JSON text); anything else yields []. */
export declare function normalizeScriptVariants(value: unknown): string[];
/** The first rule the extra versions break, or null when they are valid. */
export declare function scriptVariantsProblem(variants: unknown, primaryScript: string | null | undefined): string | null;
/** The next version to dispatch (`scripts[0]` is the primary version), or null when no version is allowed. */
export declare function chooseScriptVariant(input: {
  scripts: readonly string[];
  lastVariantIndex: number | null;
  isAllowed: (script: string, index: number) => boolean;
}): { variantIndex: number; skipped: number[] } | null;
