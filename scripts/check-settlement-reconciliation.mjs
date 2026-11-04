import { readFile } from "node:fs/promises";

const files = await Promise.all([
  "infra/postgres/migrations/062_settlement_reconciliation.sql",
  "apps/console/lib/settlements.ts",
  "apps/console/app/api/v1/runtime/settlement-batches/route.ts",
  "apps/console/app/api/v1/settlement-batches/route.ts",
  "apps/console/app/api/v1/settlement-exceptions/[exceptionId]/resolve/route.ts",
  "apps/console/lib/runtime-service-auth.ts",
  "apps/console/proxy.ts",
  "scripts/verify-postgres-schema.mjs"
].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
const [migration, settlements, ingest, list, resolve, serviceAuth, proxy, schema] = files;

for (const required of ["settlement_batches", "settlement_lines", "settlement_reconciliation_exceptions", "source_sha256", "evidence_ref", "settlement_batches_governed_mutation", "settlement_lines_governed_mutation", "settlement_exceptions_governed_mutation", "tenant_isolation_settlement_batches", "settlement exception resolver must be an active tenant member"]) if (!migration.includes(required)) throw new Error(`settlement migration missing ${required}`);
for (const required of ["importSettlementBatch", "reconciliationCandidates", "missing_operational_event", "missing_settlement_line", "statement_net_mismatch", "recordAuditEventInTransaction", "resolveSettlementException"]) if (!settlements.includes(required)) throw new Error(`settlement service missing ${required}`);
if (!ingest.includes("requireSettlementIngestService(request, body.tenantId)") || !ingest.includes("channelVerificationStatus")) throw new Error("settlement ingest must use a dedicated private credential and verified channel");
if (!list.includes("requireRole(actor, [\"admin\", \"operator\", \"reviewer\", \"analyst\"])") || !resolve.includes("requireRole(actor, [\"admin\", \"reviewer\"])")) throw new Error("settlement read and resolution roles are incomplete");
if (!serviceAuth.includes("SETTLEMENT_INGEST_TENANT_TOKENS") || !proxy.includes("/api/v1/runtime/settlement-batches")) throw new Error("settlement ingest is not isolated from browser authentication");
for (const required of ["settlement_batches", "settlement_lines", "settlement_reconciliation_exceptions", "结算账单来源不得改写", "结算账单行不得改写", "已结案结算差异不得改写"]) if (!schema.includes(required)) throw new Error(`PostgreSQL settlement verification missing ${required}`);

console.log("PASS  settlement statement import, reconciliation exceptions, and governed resolution are wired through database, APIs, and verification");
