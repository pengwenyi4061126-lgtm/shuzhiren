// Reference copy of `programHash` from commit f0fc02e (apps/console/lib/show-program.ts, before script variants).
// Source: `git show f0fc02e:apps/console/lib/show-program.ts`. Test fixture only; product code must not import it.
// scripts/test-script-variants.mjs (Property 8) compares the extended programHash against this copy.
import { createHash } from "node:crypto";

export function programHash(segments) {
  return createHash("sha256").update(JSON.stringify(segments.map((segment) => ({ position: segment.position, kind: segment.kind, title: segment.title, durationSeconds: segment.durationSeconds, productVersionId: segment.productVersionId ?? null, purpose: segment.purpose, runtimeScript: segment.runtimeScript ?? null, fallback: segment.fallback })))).digest("hex");
}
