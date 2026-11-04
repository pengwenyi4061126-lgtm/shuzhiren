export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}

export function isGitCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value);
}

const controlledEvidenceRefPattern = /^(?:evidence:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}|urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255})$/;
export function isControlledEvidenceRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300 && controlledEvidenceRefPattern.test(value);
}

export function isSafeObjectKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || value.startsWith("/") || value.includes("\\") || value.includes("://")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
