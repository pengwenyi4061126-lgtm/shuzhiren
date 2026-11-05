import { readFile } from "node:fs/promises";

const [client, assets, route, approvalRoute, migration, integration] = await Promise.all([
  readFile(new URL("../apps/console/lib/media-evidence.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/assets.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/app/api/v1/assets/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/app/api/v1/assets/[assetId]/approve/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/058_media_asset_content_verification.sql", import.meta.url), "utf8"),
  readFile(new URL("../scripts/test-control-plane-postgres.mjs", import.meta.url), "utf8")
]);

for (const source of ["MEDIA_EVIDENCE_VERIFIER_URL", "MEDIA_EVIDENCE_VERIFIER_TOKEN", "/v1/media-evidence/verify", "expectedChecksum", "contentTypeMatches", "isOpaqueEvidenceRef", "^(?:evidence|urn):", "objectVersion", "verifiedAt"]) {
  if (!client.includes(source)) throw new Error(`Media evidence client must retain verifier contract: ${source}`);
}
for (const source of ["verifyMediaAssetContent(context, input)", "verifyMediaAssetContent(context, candidate)", "contentVerificationPresent", "缺少受控对象内容验证", "verified_object_version"]) {
  if (!assets.includes(source)) throw new Error(`Media asset workflow must require actual content verification: ${source}`);
}
if (!route.includes("media_evidence_verification_failed")) throw new Error("Media asset registration must report a failed verifier check");
// Registration and approval audit the verifier evidence in the transaction that writes the asset, not afterwards in the route.
for (const source of ["verificationEvidenceRef: asset.contentVerification?.evidenceRef", "recordAuditEventInTransaction(client, context, mediaAssetCreatedAudit(asset))", "recordAuditEventInTransaction(client, context, mediaAssetApprovedAudit(asset))"]) {
  if (!assets.includes(source)) throw new Error(`Media asset registration and approval must audit verifier evidence in their transaction: ${source}`);
}
for (const [name, source] of [["registration", route], ["approval", approvalRoute]]) {
  if (source.includes("recordAuditEvent")) throw new Error(`Media asset ${name} route must not write its audit event outside the asset transaction`);
}
for (const source of ["verified_object_version", "verification_evidence_ref", "new.verified_at is not distinct from old.verified_at", "media_assets_governed_evidence_mutation", "content-verified approval"]) {
  if (!migration.includes(source)) throw new Error(`Media evidence migration must freeze version-bound verification: ${source}`);
}
for (const source of ["/v1/media-evidence/verify", "Integration verified music", "integration-version-1"]) {
  if (!integration.includes(source)) throw new Error(`PostgreSQL integration test must exercise verified media evidence: ${source}`);
}

console.log("PASS  media assets require version-bound private object-content verification before approval");
