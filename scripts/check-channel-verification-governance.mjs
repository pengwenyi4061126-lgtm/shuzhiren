import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const [migration, channels, route, integration, schema] = await Promise.all([
  read("infra/postgres/migrations/059_channel_connection_verification_governance.sql"),
  read("apps/console/lib/channels.ts"),
  read("apps/console/app/api/v1/channels/connections/[connectionId]/verify/route.ts"),
  read("scripts/test-control-plane-postgres.mjs"),
  read("scripts/verify-postgres-schema.mjs")
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
for (const required of ["isChannelVerificationEvidenceRef", "channel_connection.verified", "verificationEvidenceRef"]) {
  if (!route.includes(required)) throw new Error(`Channel verification route must retain controlled evidence and audit handling: ${required}`);
}
for (const required of ["verification_evidence_ref", "channelVerifier", "unsafeChannelVerification", "governedChannelVerification"]) {
  if (!integration.includes(required)) throw new Error(`PostgreSQL integration coverage must verify channel evidence governance: ${required}`);
}
for (const required of ["无验证证据的渠道不得启用", "渠道密钥引用不得改写"]) {
  if (!schema.includes(required)) throw new Error(`PostgreSQL schema verification must reject invalid channel governance mutations: ${required}`);
}

console.log("PASS  channel verification evidence and immutable connection governance are wired through migration, API, and integration coverage");
