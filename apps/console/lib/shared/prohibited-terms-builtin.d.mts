import type { RawLexiconTerm } from "./prohibited-terms.mjs";

/** Sample lexicon version; changes whenever a built-in term or suggestion changes. */
export declare const BUILTIN_LEXICON_VERSION: string;
/** The sample built-in terms (not reviewed by legal counsel); category is never "custom". */
export declare const BUILTIN_LEXICON: readonly (RawLexiconTerm & { readonly suggestions: readonly string[] })[];
