import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [migration, remediation, channels, evidence, route, interactionRoute, commerceRoute, replies, integration, schema, ci] = await Promise.all([
  read("infra/postgres/migrations/059_channel_connection_verification_governance.sql"),
  read("infra/postgres/migrations/061_channel_verification_remediation.sql"),
  read("apps/console/lib/channels.ts"),
  read("apps/console/lib/channel-evidence.ts"),
  read("apps/console/app/api/v1/channels/connections/[connectionId]/verify/route.ts"),
  read("apps/console/app/api/v1/runtime/channel-interactions/route.ts"),
  read("apps/console/app/api/v1/runtime/channel-commerce/route.ts"),
  read("apps/console/lib/channel-replies.ts"),
  read("scripts/test-control-plane-postgres.mjs"),
  read("scripts/verify-postgres-schema.mjs"),
  read(".github/workflows/ci.yml")
]);

for (const required of [
  "channel_connections_verification_evidence_ref_check",
  "channel_connections_connected_verification_check",
  "enforce_channel_connection_verification",
  "channel_connections_governed_verification",
  "connected channel connections require verification evidence",
  "channel connection configuration is immutable"
]) if (!migration.includes(required)) throw new Error(`Channel verification migration is missing: ${required}`);

for (const required of ["isChannelVerificationEvidenceRef", "evidence://", "urn:", "渠道连接验证证据格式不符合受控引用要求"]) {
  if (!channels.includes(required)) throw new Error(`Channel service must enforce controlled verification evidence: ${required}`);
}
for (const required of ["verifyChannelConnectionEvidence", "configurationSha256", "/v1/channel-evidence/verify"]) {
  if (!evidence.includes(required)) throw new Error(`Channel evidence verifier contract is missing: ${required}`);
}
for (const required of ["recordChannelVerification", "isVerificationInput"]) {
  if (!route.includes(required)) throw new Error(`Channel verification route must delegate only validated state changes: ${required}`);
}
for (const required of ["recordAuditEventInTransaction", "channel_connection.verified"]) {
  if (!channels.includes(required)) throw new Error(`Channel verification must atomically persist the audit event: ${required}`);
}
for (const source of [interactionRoute, commerceRoute, replies]) if (!source.includes("channelVerificationStatus")) throw new Error("Runtime channel intake and reply delivery must enforce current verification");
for (const required of ["verification_evidence_ref", "channelVerifierId", "unsafeChannelVerification", "governedChannelVerification", "governedChannelAudit"]) {
  if (!integration.includes(required)) throw new Error(`PostgreSQL integration coverage must verify channel evidence governance: ${required}`);
}
for (const required of ["无验证证据的渠道不得启用", "非租户成员不得作为渠道验证人", "渠道密钥引用不得改写"]) {
  if (!schema.includes(required)) throw new Error(`PostgreSQL schema verification must reject invalid channel governance mutations: ${required}`);
}
for (const required of ["channel verification actor must be an active tenant member", "update channel_connections", "validate constraint channel_connections_verification_evidence_ref_check"]) {
  if (!remediation.includes(required)) throw new Error(`Channel verification remediation migration is missing: ${required}`);
}
for (const required of ["runtime:preview:check", "media:evidence:check", "channel:verification:check"]) {
  if (!ci.includes(required)) throw new Error(`CI must execute channel and evidence governance gate: ${required}`);
}

console.log("PASS  channel verification evidence and immutable connection governance are wired through migration, API, and integration coverage");
