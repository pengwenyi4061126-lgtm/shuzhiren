// Script variants and their deterministic rotation (design.md module C, K4). Shared by the console and the
// runtime worker; pure: no clock, no random numbers, only node: built-ins and sibling modules may be imported.
//
// A segment has up to five versions of its runtime script: version 0 is the primary runtime_script, versions
// 1..k are runtime_script_variants[0..k-1]. The rules below mirror script_variants_valid() in migration 085.

export const maxScriptVariants = 4;
export const maxScriptLength = 800;

// "Blank" means only ASCII whitespace, spelled out like the database regex so both sides agree.
const blankScript = /^[ \t\r\n\f\v]*$/;

/**
 * The variants of a runtime_script_variants value (an array, or its JSON text) as a string array.
 * Anything that is not an array yields []; non-string elements are dropped.
 */
export function normalizeScriptVariants(value) {
  let variants = value;
  if (typeof variants === "string") {
    try {
      variants = JSON.parse(variants);
    } catch {
      return [];
    }
  }
  return Array.isArray(variants) ? variants.filter((item) => typeof item === "string") : [];
}

/**
 * The first rule the extra versions of a segment break, as a message, or null when they are valid:
 * an array of 0-4 strings of 1-800 characters, not blank, pairwise different and different from the primary
 * version; a non-empty list also needs a non-blank primary version.
 */
export function scriptVariantsProblem(variants, primaryScript) {
  if (!Array.isArray(variants)) return "runtimeScriptVariants must be an array of strings";
  if (variants.length > maxScriptVariants) return `runtimeScriptVariants may hold at most ${maxScriptVariants} versions`;
  const seen = new Set();
  for (const [index, variant] of variants.entries()) {
    const label = `runtimeScriptVariants[${index}]`;
    if (typeof variant !== "string") return `${label} must be a string`;
    const length = [...variant].length;
    if (length < 1 || length > maxScriptLength) return `${label} must be 1-${maxScriptLength} characters`;
    if (blankScript.test(variant)) return `${label} must not be blank`;
    if (variant === primaryScript) return `${label} must differ from the primary script`;
    if (seen.has(variant)) return `${label} duplicates an earlier version`;
    seen.add(variant);
  }
  if (variants.length > 0 && (typeof primaryScript !== "string" || blankScript.test(primaryScript))) {
    return "runtimeScriptVariants require a non-blank primary runtime script";
  }
  return null;
}

/**
 * The version to dispatch next. `scripts[0]` is the primary version; `lastVariantIndex` is the version of the
 * last ledger row of this run and segment (null when there is none). The search starts after the last version,
 * wraps around, and takes the first version `isAllowed(script, index)` accepts; `skipped` lists the refused
 * indexes visited before it, in visiting order. Returns null when no version is allowed.
 *
 * @param {{ scripts: readonly string[], lastVariantIndex: number | null, isAllowed: (script: string, index: number) => boolean }} input
 * @returns {{ variantIndex: number, skipped: number[] } | null}
 */
export function chooseScriptVariant({ scripts, lastVariantIndex, isAllowed }) {
  const count = Array.isArray(scripts) ? scripts.length : 0;
  if (count < 1 || count > maxScriptVariants + 1) throw new RangeError("scripts must hold 1-5 versions");
  if (lastVariantIndex !== null && !(Number.isInteger(lastVariantIndex) && lastVariantIndex >= 0 && lastVariantIndex < count)) {
    throw new RangeError("lastVariantIndex must be null or an index of scripts");
  }
  const start = lastVariantIndex === null ? 0 : (lastVariantIndex + 1) % count;
  const skipped = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    if (isAllowed(scripts[index], index)) return { variantIndex: index, skipped };
    skipped.push(index);
  }
  return null;
}
