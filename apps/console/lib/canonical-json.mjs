// Canonical JSON used for hashes and signatures that other programs recompute.
//
// Rule version 2 (current): null, booleans, strings and finite numbers use
// JSON.stringify (numbers follow ECMAScript Number::toString, which does not
// depend on locale); undefined array elements become null; only plain objects
// (prototype Object.prototype or null) are accepted, undefined members are
// dropped and keys are sorted by Unicode code point. For well-formed strings
// this equals UTF-8 byte order, Python sorted() and Go sort.Strings. Any other
// value (non-finite number, bigint, symbol, function, Date, Map, Buffer, ...)
// throws CanonicalJsonError with its JSON path. No Intl or locale API is used.
//
// Rule version 1 (legacy): the previous algorithm, which sorted keys with
// String#localeCompare in the process default locale. It is kept only to verify
// values that were sealed with it.

export const CANONICAL_JSON_RULE_VERSION = 2;
export const CANONICAL_JSON_RULE_VERSIONS = Object.freeze([1, 2]);

export class CanonicalJsonError extends TypeError {
  constructor(message, path) {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

export function isCanonicalJsonRuleVersion(value) {
  return value === 1 || value === 2;
}

// Compares by code point; when one key is a prefix of the other, the shorter
// key sorts first.
export function compareCodePoints(left, right) {
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

export function canonicalJson(value, { ruleVersion = CANONICAL_JSON_RULE_VERSION } = {}) {
  if (ruleVersion === 1) return legacyV1(value);
  if (ruleVersion === 2) return v2(value, "$");
  throw new RangeError(`unsupported Canonical_JSON rule version: ${ruleVersion}`);
}

function legacyV1(value) {
  if (Array.isArray(value)) return `[${value.map(legacyV1).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${legacyV1(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function v2(value, path) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number", path);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => (item === undefined ? "null" : v2(item, `${path}[${index}]`))).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonError("unsupported object", path);
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => compareCodePoints(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${v2(item, `${path}.${key}`)}`).join(",")}}`;
  }
  throw new CanonicalJsonError(`unsupported ${typeof value} value`, path);
}
