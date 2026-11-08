import { createHash } from "node:crypto";

export function creationProjectScriptReviewSha256(productVersionId: string, script: string) {
  return createHash("sha256").update(JSON.stringify({ productVersionId, script })).digest("hex");
}
