// M13 (Requirement 29, migration 075): the five *_approved_insert_evidence triggers. A row inserted directly
// as approved must carry its approval evidence columns (passed to enforce_approved_insert_evidence() as
// trigger arguments); rows inserted in another state are not checked.
import { createHash, randomUUID } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MEDIA_EVIDENCE = { verified_object_version: "it-approved-insert-v1", verified_bytes: 2048, verified_content_type: "audio/wav", verification_evidence_ref: "evidence://integration/approved-insert", verified_at: "now" };

/** One builder per table: returns the INSERT for an approved row with the given evidence values. */
const TABLES = {
  product_versions: {
    async prepare({ client }, tenantId) {
      const productId = randomUUID();
      await client.query("insert into products (id, tenant_id, external_sku, name) values ($1, $2, $3, 'M13 product')", [productId, tenantId, `m13-${productId}`]);
      return { productId };
    },
    insert: (a, evidence) => ({ sql: "insert into product_versions (id, tenant_id, product_id, revision, facts, approval_status, approved_by, approved_at) values ($1, $2, $3, 1, '{\"priceCent\":100,\"stock\":1}'::jsonb, 'approved', $4, $5)", params: [a.rowId, a.tenantId, a.productId, evidence.approved_by, evidence.approved_at] })
  },
  show_revisions: {
    async prepare({ client }, tenantId) {
      const showId = randomUUID();
      await client.query("insert into shows (id, tenant_id, name) values ($1, $2, 'M13 show')", [showId, tenantId]);
      return { showId };
    },
    insert: (a, evidence) => ({ sql: "insert into show_revisions (id, tenant_id, show_id, revision, plan, approval_status, approved_by, approved_at) values ($1, $2, $3, 1, '{}'::jsonb, 'approved', $4, $5)", params: [a.rowId, a.tenantId, a.showId, evidence.approved_by, evidence.approved_at] })
  },
  model_releases: {
    prepare: async () => ({}),
    insert: (a, evidence) => ({ sql: "insert into model_releases (id, tenant_id, name, version, component, source_commit, image_digest, artifact_hash, driver_version, license, rights_scope, evidence_ref, validation_summary, approval_status, approved_by, approved_at) values ($1, $2, 'M13 release', $3, 'runtime', 'm13-commit', 'sha256:m13-image', 'sha256:m13-artifact', 'm13-driver', 'Apache-2.0', 'M13 scope', 'evidence://integration/m13-release', 'M13 release', 'approved', $4, $5)", params: [a.rowId, a.tenantId, `m13-${a.rowId}`, evidence.approved_by, evidence.approved_at] })
  },
  policy_profiles: {
    prepare: async () => ({}),
    insert: (a, evidence) => ({ sql: "insert into policy_profiles (id, tenant_id, name, version, rules, evidence_ref, validation_summary, approval_status, approved_by, approved_at) values ($1, $2, $3, '1.0.0', '[]'::jsonb, 'evidence://integration/m13-policy', 'M13 policy', 'approved', $4, $5)", params: [a.rowId, a.tenantId, `M13 policy ${a.rowId}`, evidence.approved_by, evidence.approved_at] })
  },
  media_assets: {
    prepare: async () => ({}),
    insert: (a, evidence) => ({
      sql: "insert into media_assets (id, tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, approval_status, approved_by, approved_at, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at) values ($1, $2, 'music', 'M13 media', $3, $4, 'M13 rights', 'evidence://integration/m13-media', 'approved', $5, $6, $7, $8, $9, $10, $11)",
      params: [a.rowId, a.tenantId, `assets/m13/${a.rowId}.wav`, `sha256:${sha256(a.rowId)}`, evidence.approved_by, evidence.approved_at, evidence.verified_object_version, evidence.verified_bytes, evidence.verified_content_type, evidence.verification_evidence_ref, evidence.verified_at]
    })
  }
};

function caseFor(table, { missing } = {}) {
  const builder = TABLES[table];
  const evidenceFor = (a) => {
    const evidence = { approved_by: a.approverId, approved_at: new Date(), ...(table === "media_assets" ? { ...MEDIA_EVIDENCE, verified_at: new Date() } : {}) };
    if (missing) evidence[missing] = null;
    return evidence;
  };
  return {
    id: `${table}.approved_insert_evidence.insert.${missing ? `missing_${missing}.reject` : "complete.accept"}`,
    table, trigger: `${table}_approved_insert_evidence`, op: "INSERT", expect: missing ? "reject" : "accept",
    ...(missing ? { message: `approved_insert_requires_evidence: ${table}.${missing} must not be null` } : { expectedAfter: (a) => [{ id: a.rowId, approval_status: "approved", approved_by: a.approverId }] }),
    async arrange(ctx) {
      const tenantId = await ctx.seed.tenant();
      const approverId = await ctx.seed.member({ tenantId, role: "reviewer" });
      return { tenantId, approverId, rowId: randomUUID(), ...(await builder.prepare(ctx, tenantId)) };
    },
    act: (_ctx, a) => builder.insert(a, evidenceFor(a)),
    readBack: (_ctx, a) => ({ sql: `select id, approval_status::text as approval_status, approved_by from ${table} where id = $1`, params: [a.rowId] })
  };
}

export default [
  ...Object.keys(TABLES).map((table) => caseFor(table)),
  ...Object.keys(TABLES).map((table) => caseFor(table, { missing: "approved_by" })),
  caseFor("media_assets", { missing: "verification_evidence_ref" })
];
