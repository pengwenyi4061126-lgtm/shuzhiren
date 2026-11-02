import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type ProductFacts = { priceCent: number; unitCostCent?: number; stock: number; highlights: string[]; faq: string[]; sourceRef: string; sourceSyncedAt: string; validFrom: string; validUntil?: string };
export type ProductVersion = { id: string; revision: number; status: "draft" | "approved" | "rejected"; facts: ProductFacts; createdAt: string; approvedAt?: string };
export type Product = { id: string; tenantId: string; externalSku: string; name: string; versions: ProductVersion[] };
export type FrozenProductVersionStatus = { active: boolean; detail: string; version?: ProductVersion };

type Catalog = { products: Map<string, Product> };
type PersistentProductRow = {
  id: string;
  tenant_id: string;
  external_sku: string;
  name: string;
  version_id: string | null;
  revision: number | null;
  approval_status: ProductVersion["status"] | null;
  facts: unknown;
  version_created_at: Date | string | null;
  approved_at: Date | string | null;
};
type FrozenProductVersionRow = { run_product_version_id: string | null; frozen_product_version_id: string | null; id: string | null; revision: number | null; approval_status: ProductVersion["status"] | null; facts: unknown; created_at: Date | string | null; approved_at: Date | string | null };

declare global { var shuzhirenCatalog: Catalog | undefined; }

function catalog(): Catalog {
  globalThis.shuzhirenCatalog ??= {
    products: new Map([["product_a102", {
      id: "product_a102", tenantId: "tenant_demo", externalSku: "A-102", name: "氨基酸洁面慕斯",
      versions: [{
        id: "pv_a102_v1", revision: 1, status: "approved",
        facts: { priceCent: 9900, unitCostCent: 3200, stock: 286, highlights: ["氨基酸表活", "按压泡沫"], faq: ["赠旅行装三件套", "48 小时内发货"], sourceRef: "pim://demo/A-102/revision-18", sourceSyncedAt: "2026-11-01T08:00:00.000Z", validFrom: "2026-11-01T08:00:00.000Z", validUntil: "2026-11-03T08:00:00.000Z" },
        createdAt: "2026-11-01T08:00:00.000Z", approvedAt: "2026-11-01T08:30:00.000Z"
      }]
    }]])
  };
  return globalThis.shuzhirenCatalog;
}

export async function listProducts(context: RequestContext) {
  if (!databasePool()) return demoProducts(context);
  return withTenantTransaction(context.tenantId, async (client) => loadProducts(client));
}

export async function findProduct(context: RequestContext, productId: string) {
  if (!databasePool()) {
    const product = catalog().products.get(productId);
    return product?.tenantId === context.tenantId ? product : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => (await loadProducts(client, productId))[0] ?? null);
}

export async function createProduct(context: RequestContext, input: { externalSku: string; name: string }) {
  if (!databasePool()) {
    if (demoProducts(context).some((product) => product.externalSku === input.externalSku)) throw new Response("SKU already exists", { status: 409 });
    const product: Product = { id: `product_${crypto.randomUUID()}`, tenantId: context.tenantId, externalSku: input.externalSku, name: input.name, versions: [] };
    catalog().products.set(product.id, product);
    return product;
  }
  try {
    return await withTenantTransaction(context.tenantId, async (client) => {
      const result = await client.query<{ id: string; tenant_id: string; external_sku: string; name: string }>(
        "insert into products (tenant_id, external_sku, name) values ($1, $2, $3) returning id, tenant_id, external_sku, name",
        [context.tenantId, input.externalSku, input.name]
      );
      const row = result.rows[0];
      return { id: row.id, tenantId: row.tenant_id, externalSku: row.external_sku, name: row.name, versions: [] };
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") throw new Response("SKU already exists", { status: 409 });
    throw error;
  }
}

export async function createProductVersion(context: RequestContext, productId: string, facts: ProductFacts) {
  if (!databasePool()) {
    const product = await findProduct(context, productId);
    if (!product) throw new Response("Product not found", { status: 404 });
    const version: ProductVersion = { id: `pv_${crypto.randomUUID()}`, revision: product.versions.length + 1, status: "draft", facts, createdAt: new Date().toISOString() };
    product.versions.unshift(version);
    return version;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const product = await client.query<{ id: string }>("select id from products where id = $1 for update", [productId]);
    if (!product.rows[0]) throw new Response("Product not found", { status: 404 });
    const nextRevision = await client.query<{ revision: number }>("select coalesce(max(revision), 0) + 1 as revision from product_versions where product_id = $1", [productId]);
    const result = await client.query<{ id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string }>(
      "insert into product_versions (tenant_id, product_id, revision, facts, approval_status) values ($1, $2, $3, $4::jsonb, 'draft') returning id, revision, approval_status, facts, created_at",
      [context.tenantId, productId, nextRevision.rows[0].revision, JSON.stringify(facts)]
    );
    return persistentVersion(result.rows[0]);
  });
}

export async function approveProductVersion(context: RequestContext, productId: string, versionId: string) {
  if (!databasePool()) {
    const product = await findProduct(context, productId);
    const version = product?.versions.find((candidate) => candidate.id === versionId);
    if (!version) throw new Response("Product version not found", { status: 404 });
    if (!isProductFactsCurrent(version.facts)) throw new Response("Product source facts are stale or outside their valid period", { status: 409 });
    version.status = "approved";
    version.approvedAt = new Date().toISOString();
    return version;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const candidate = await client.query<{ facts: unknown }>("select facts from product_versions where id = $1 and product_id = $2 for update", [versionId, productId]);
    if (!candidate.rows[0]) throw new Response("Product version not found", { status: 404 });
    if (!isProductFactsCurrent(candidate.rows[0].facts as ProductFacts)) throw new Response("Product source facts are stale or outside their valid period", { status: 409 });
    const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
    const result = await client.query<{ id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string; approved_at: Date | string | null }>(
      "update product_versions set approval_status = 'approved', approved_by = $3, approved_at = now() where id = $1 and product_id = $2 returning id, revision, approval_status, facts, created_at, approved_at",
      [versionId, productId, actor.rows[0].id]
    );
    if (!result.rows[0]) throw new Response("Product version not found", { status: 404 });
    return persistentVersion(result.rows[0]);
  });
}

export async function findApprovedProductVersion(context: RequestContext, versionId: string) {
  if (!databasePool()) {
    const product = demoProducts(context).find((candidate) => candidate.versions.some((version) => version.id === versionId));
    const version = product?.versions.find((candidate) => candidate.id === versionId);
    return version?.status === "approved" && isProductFactsCurrent(version.facts) ? version : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<{ id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string; approved_at: Date | string | null }>(
      "select id, revision, approval_status, facts, created_at, approved_at from product_versions where id = $1 and approval_status = 'approved'",
      [versionId]
    );
    const version = result.rows[0] ? persistentVersion(result.rows[0]) : null;
    return version && isProductFactsCurrent(version.facts) ? version : null;
  });
}

export async function frozenProductVersionStatusForRun(context: RequestContext, runId: string, expectedVersionId?: string): Promise<FrozenProductVersionStatus> {
  if (!databasePool()) {
    const runVersion = expectedVersionId ?? (runId === "run_20261101_001" ? "pv_a102_v1" : undefined);
    const version = runVersion ? await findApprovedProductVersion(context, runVersion) : null;
    return version ? { active: true, detail: `开发态已冻结商品版本 v${version.revision}`, version } : { active: false, detail: "场次缺少有效的冻结商品版本" };
  }
  return withTenantTransaction(context.tenantId, async (client) => frozenProductVersionStatusForRunInTransaction(client, runId));
}

export async function frozenProductVersionStatusForRunInTransaction(client: PoolClient, runId: string): Promise<FrozenProductVersionStatus> {
  const result = await client.query<FrozenProductVersionRow>(
    `select r.product_version_id as run_product_version_id, binding.product_version_id as frozen_product_version_id,
      pv.id, pv.revision, pv.approval_status, pv.facts, pv.created_at, pv.approved_at
     from live_runs r
     left join show_revision_product_versions binding on binding.show_revision_id = r.show_revision_id and binding.slot_key = 'primary'
     left join product_versions pv on pv.id = binding.product_version_id
     where r.id = $1`,
    [runId]
  );
  const row = result.rows[0];
  if (!row?.frozen_product_version_id || !row.id || !row.revision || !row.approval_status || !row.created_at) return { active: false, detail: "场次修订缺少主商品冻结绑定" };
  if (row.run_product_version_id !== row.frozen_product_version_id) return { active: false, detail: "场次商品字段与冻结商品版本不一致" };
  const version = persistentVersion({ id: row.id, revision: row.revision, approval_status: row.approval_status, facts: row.facts, created_at: row.created_at, approved_at: row.approved_at });
  if (version.status !== "approved") return { active: false, detail: `冻结商品版本 v${version.revision} 未获批准` };
  if (!isProductFactsCurrent(version.facts)) return { active: false, detail: `冻结商品版本 v${version.revision} 的来源已过期或不在有效期` };
  return { active: true, detail: `已冻结商品版本 v${version.revision}，来源与有效期均有效`, version };
}

function demoProducts(context: RequestContext) {
  return [...catalog().products.values()].filter((product) => product.tenantId === context.tenantId);
}

async function loadProducts(client: PoolClient, productId?: string) {
  const result = await client.query<PersistentProductRow>(
    `select p.id, p.tenant_id, p.external_sku, p.name, v.id as version_id, v.revision,
      v.approval_status, v.facts, v.created_at as version_created_at, v.approved_at
     from products p left join product_versions v on v.product_id = p.id
     where ($1::uuid is null or p.id = $1)
     order by p.created_at desc, v.revision desc`,
    [productId ?? null]
  );
  const products = new Map<string, Product>();
  for (const row of result.rows) {
    let product = products.get(row.id);
    if (!product) {
      product = { id: row.id, tenantId: row.tenant_id, externalSku: row.external_sku, name: row.name, versions: [] };
      products.set(product.id, product);
    }
    if (row.version_id && row.revision && row.approval_status && row.version_created_at) {
      product.versions.push(persistentVersion({ id: row.version_id, revision: row.revision, approval_status: row.approval_status, facts: row.facts, created_at: row.version_created_at, approved_at: row.approved_at }));
    }
  }
  return [...products.values()];
}

function persistentVersion(row: { id: string; revision: number; approval_status: ProductVersion["status"]; facts: unknown; created_at: Date | string; approved_at?: Date | string | null }): ProductVersion {
  return {
    id: row.id,
    revision: row.revision,
    status: row.approval_status,
    facts: row.facts as ProductFacts,
    createdAt: new Date(row.created_at).toISOString(),
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : undefined
  };
}

export function isProductFactsCurrent(facts: ProductFacts, now = new Date()) {
  const syncedAt = Date.parse(facts.sourceSyncedAt);
  const validFrom = Date.parse(facts.validFrom);
  const validUntil = facts.validUntil ? Date.parse(facts.validUntil) : undefined;
  if (!facts.sourceRef.trim() || !Number.isFinite(syncedAt) || !Number.isFinite(validFrom)) return false;
  if (syncedAt > now.getTime() + 5 * 60_000 || now.getTime() - syncedAt > 24 * 60 * 60_000) return false;
  if (validFrom > now.getTime()) return false;
  return validUntil === undefined || (Number.isFinite(validUntil) && validUntil > now.getTime());
}

function databaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
