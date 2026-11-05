import { createHash } from "node:crypto";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import type { Product, ProductFacts, ProductVersion } from "@/lib/catalog";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";

export type ProductFactIngestInput = { externalEventId: string; externalSku: string; name: string; facts: ProductFacts };
export type ProductFactIngestResult = { product: Product; version: ProductVersion; duplicate: boolean };
type PersistentIngestRow = { payload_hash: string; product_id: string; tenant_id: string; external_sku: string; name: string; version_id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string; approved_at: Date | string | null };
type DemoStore = { products: Map<string, Product>; events: Map<string, { productId: string; versionId: string; payloadHash: string }> };

declare global { var shuzhirenProductIngestStore: DemoStore | undefined; }

function demoStore() { return globalThis.shuzhirenProductIngestStore ??= { products: new Map(), events: new Map() }; }

export async function ingestProductFacts(context: RequestContext, input: ProductFactIngestInput): Promise<ProductFactIngestResult> {
  const payloadHash = hash(input);
  if (!databasePool()) {
    const result = ingestDemo(context, input, payloadHash);
    if (!result.duplicate) await recordAuditEvent(context, productFactsIngestedAudit(result));
    return result;
  }
  // The ingested version, its ingest event and the product_facts.ingested audit event commit together.
  return withTenantTransaction(context.tenantId, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.tenantId}:${input.externalEventId}`]);
    const previous = await client.query<PersistentIngestRow>(
      `select e.payload_hash, p.id as product_id, p.tenant_id, p.external_sku, p.name, v.id as version_id, v.revision, v.approval_status, v.facts, v.created_at, v.approved_at
       from product_fact_ingest_events e join product_versions v on v.id = e.product_version_id join products p on p.id = v.product_id where e.external_event_id = $1`,
      [input.externalEventId],
    );
    if (previous.rows[0]) return persistedResult(previous.rows[0], payloadHash);
    const productResult = await client.query<{ id: string; tenant_id: string; external_sku: string; name: string }>(
      `insert into products (tenant_id, external_sku, name) values ($1, $2, $3)
       on conflict (tenant_id, external_sku) do update set name = excluded.name
       returning id, tenant_id, external_sku, name`, [context.tenantId, input.externalSku, input.name],
    );
    const product = productResult.rows[0];
    const revision = await client.query<{ revision: number }>("select coalesce(max(revision), 0) + 1 as revision from product_versions where product_id = $1", [product.id]);
    const versionResult = await client.query<{ id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string }>(
      "insert into product_versions (tenant_id, product_id, revision, facts, approval_status) values ($1, $2, $3, $4::jsonb, 'draft') returning id, revision, approval_status, facts, created_at", [context.tenantId, product.id, revision.rows[0].revision, JSON.stringify(input.facts)],
    );
    const version = versionFromRow(versionResult.rows[0]);
    await client.query("insert into product_fact_ingest_events (tenant_id, external_event_id, product_version_id, payload_hash) values ($1, $2, $3, $4)", [context.tenantId, input.externalEventId, version.id, payloadHash]);
    const result: ProductFactIngestResult = { product: { id: product.id, tenantId: product.tenant_id, externalSku: product.external_sku, name: product.name, versions: [] }, version, duplicate: false };
    await recordAuditEventInTransaction(client, context, productFactsIngestedAudit(result));
    return result;
  });
}
function productFactsIngestedAudit(result: ProductFactIngestResult): AuditEventInput {
  return { type: "product_facts.ingested", resource: "product_version", resourceId: result.version.id, detail: { productId: result.product.id, externalSku: result.product.externalSku, revision: result.version.revision, sourceRef: result.version.facts.sourceRef } };
}

function ingestDemo(context: RequestContext, input: ProductFactIngestInput, payloadHash: string): ProductFactIngestResult {
  const store = demoStore(); const eventKey = `${context.tenantId}:${input.externalEventId}`; const previous = store.events.get(eventKey);
  if (previous) {
    if (previous.payloadHash !== payloadHash) throw new Response("External product fact event payload differs from its original delivery", { status: 409 });
    const product = store.products.get(previous.productId); const version = product?.versions.find((candidate: ProductVersion) => candidate.id === previous.versionId);
    if (!product || !version) throw new Error("Product fact ingest replay references missing data");
    return { product, version, duplicate: true };
  }
  let product = [...store.products.values()].find((candidate) => candidate.tenantId === context.tenantId && candidate.externalSku === input.externalSku);
  if (!product) { product = { id: `product_${crypto.randomUUID()}`, tenantId: context.tenantId, externalSku: input.externalSku, name: input.name, versions: [] }; store.products.set(product.id, product); } else product.name = input.name;
  const version: ProductVersion = { id: `pv_${crypto.randomUUID()}`, revision: product.versions.length + 1, status: "draft", facts: input.facts, createdAt: new Date().toISOString() };
  product.versions.unshift(version); store.events.set(eventKey, { productId: product.id, versionId: version.id, payloadHash });
  return { product, version, duplicate: false };
}

function persistedResult(row: PersistentIngestRow, payloadHash: string): ProductFactIngestResult {
  if (row.payload_hash !== payloadHash) throw new Response("External product fact event payload differs from its original delivery", { status: 409 });
  return { product: { id: row.product_id, tenantId: row.tenant_id, externalSku: row.external_sku, name: row.name, versions: [] }, version: versionFromRow({ id: row.version_id, revision: row.revision, approval_status: row.approval_status, facts: row.facts, created_at: row.created_at, approved_at: row.approved_at }), duplicate: true };
}

function versionFromRow(row: { id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string; approved_at?: Date | string | null }): ProductVersion { return { id: row.id, revision: row.revision, status: row.approval_status, facts: row.facts as ProductFacts, createdAt: new Date(row.created_at).toISOString(), approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined }; }
function hash(input: ProductFactIngestInput) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
