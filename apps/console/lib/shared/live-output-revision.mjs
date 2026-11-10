import { splitNarrationScript } from "./content-script.mjs";

export function getLiveOutputRevisionDisplay(currentRevision, sourceRevision) {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1
    || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || sourceRevision > currentRevision) {
    return { state: "unknown", label: "来源版本未知" };
  }
  if (sourceRevision === currentRevision) return { state: "current", label: `基于当前 r${currentRevision}` };
  return { state: "stale", label: `基于 r${sourceRevision}，项目已更新` };
}

export function matchesProjectRevision(currentRevision, expectedRevision) {
  return Number.isSafeInteger(currentRevision) && currentRevision > 0
    && Number.isSafeInteger(expectedRevision) && expectedRevision === currentRevision;
}

export function matchesProjectScriptToPreparedSegments(script, segments) {
  if (typeof script !== "string" || !Array.isArray(segments)) return false;
  const expected = splitNarrationScript(script).map((chunk) => chunk.trim());
  const prepared = segments.filter((segment) => segment?.kind === "prepared_product").map((segment) => segment.runtimeScript?.trim());
  if (!expected.length) return false;
  return prepared.length === expected.length && expected.every((chunk, index) => prepared[index] === chunk);
}
