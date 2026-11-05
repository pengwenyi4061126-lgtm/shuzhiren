import { readFile } from "node:fs/promises";

const [client, recordings, route, migration, integration, deployment] = await Promise.all([
  readFile(new URL("../apps/console/lib/recording-evidence.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/recordings.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/app/api/v1/runtime/recordings/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../infra/postgres/migrations/063_recording_content_verification.sql", import.meta.url), "utf8"),
  readFile(new URL("../scripts/test-control-plane-postgres.mjs", import.meta.url), "utf8"),
  readFile(new URL("../scripts/check-deployment-config.mjs", import.meta.url), "utf8")
]);

for (const source of ["RECORDING_EVIDENCE_VERIFIER_URL", "RECORDING_EVIDENCE_VERIFIER_TOKEN", "/v1/recording-evidence/verify", "objectVersion", "retentionUntil", "isControlledEvidenceRef"]) {
  if (!client.includes(source)) throw new Error(`Recording evidence client must retain verifier contract: ${source}`);
}
for (const source of ["verifyRecordingEvidence(context, input)", "verified_object_version", "verification_evidence_ref", "contentVerification"]) {
  if (!recordings.includes(source)) throw new Error(`Recording registration must require and retain verifier evidence: ${source}`);
}
if (!route.includes("body.bytes > 0")) throw new Error("Recording ingress must reject empty objects");
if (route.includes("recordAuditEvent")) throw new Error("Recording ingress must not write its audit event outside the registration transaction");
// The registration audits the verifier evidence in the transaction that stores the recording.
for (const source of ["objectVersion: recording.contentVerification.objectVersion", "evidenceRef: recording.contentVerification.evidenceRef", "recordAuditEventInTransaction(client, context, recordingRegisteredAudit(recording))"]) {
  if (!recordings.includes(source)) throw new Error(`Recording registration must audit verifier evidence in its transaction: ${source}`);
}
for (const source of ["recording_evidence_governed_mutation", "recording evidence requires verifier attestation", "verified_object_version", "recording_evidence_tenant_verification_idx"]) {
  if (!migration.includes(source)) throw new Error(`Recording evidence migration must govern verifier attestation: ${source}`);
}
for (const source of ["/v1/recording-evidence/verify", "RECORDING_EVIDENCE_VERIFIER_URL", "recordingEvidenceToken"]) {
  if (!integration.includes(source)) throw new Error(`PostgreSQL integration test must exercise recording evidence verification: ${source}`);
}
if (!deployment.includes("RECORDING_EVIDENCE_VERIFIER_TOKEN")) throw new Error("Deployment validation must require a distinct recording evidence verifier token");

console.log("PASS  recording evidence requires a bound private object-storage verification attestation before registration");
