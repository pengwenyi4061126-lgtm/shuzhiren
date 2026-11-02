import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { listAssets, requiredLiveAssetKinds, type AssetApproval, type AssetKind } from "@/lib/assets";
import { findApprovedProductVersion, type ProductFacts } from "@/lib/catalog";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { listModelReleases, requiredProductionReleaseComponents, type ReleaseApproval, type ReleaseComponent } from "@/lib/releases";
import { listPolicyProfiles, type PolicyProfileApproval } from "@/lib/policy-profiles";

type FrozenProduct = { id: string; revision: number; approval: "draft" | "approved" | "rejected"; externalSku: string; name: string; facts: ProductFacts };
type FrozenPolicy = { id: string; name: string; version: string; approval: PolicyProfileApproval; evidenceRef: string; validationSummary: string };
type FrozenModel = { id: string; component: ReleaseComponent; name: string; version: string; approval: ReleaseApproval; sourceCommit: string; artifactHash: string; evidenceRef: string };
type FrozenAsset = { id: string; kind: AssetKind; name: string; approval: AssetApproval; expiresAt?: string; objectKey: string; checksum: string; rightsScope: string; source: string };

export type RunReleaseManifest = {
  runId: string;
  revisionId: string;
  showName: string;
  frozenAt: string;
  product: FrozenProduct | null;
  policy: FrozenPolicy | null;
  models: FrozenModel[];
  assets: FrozenAsset[];
  sha256: string;
  frozenSha256?: string;
};

type ManifestRunRow = {
  run_id: string;
  revision_id: string;
  show_name: string;
  frozen_at: Date | string;
  product_id: string | null;
  product_revision: number | null;
  product_approval: "draft" | "approved" | "rejected" | null;
  external_sku: string | null;
  product_name: string | null;
  product_facts: unknown;
  policy_id: string | null;
  policy_name: string | null;
  policy_version: string | null;
  policy_approval: PolicyProfileApproval | null;
  policy_evidence_ref: string | null;
  policy_validation_summary: string | null;
  frozen_manifest_sha256: string | null;
};
type ManifestModelRow = { id: string; component: ReleaseComponent; name: string; version: string; approval_status: ReleaseApproval; source_commit: string; artifact_hash: string; evidence_ref: string };
type ManifestAssetRow = { id: string; kind: AssetKind; name: string; approval_status: AssetApproval; expires_at: Date | string | null; object_key: string; checksum: string; rights_scope: string; source_ref: string };

export async function getRunReleaseManifest(context: RequestContext, runId: string): Promise<RunReleaseManifest | null> {
  if (!databasePool()) return demoManifest(context, runId);
  return withTenantTransaction(context.tenantId, async (client) => persistentManifest(client, runId));
}

export async function createReleaseManifestSnapshotInTransaction(client: PoolClient, input: { tenantId: string; revisionId: string; runId: string }) {
  const manifest = await persistentManifest(client, input.runId);
  if (!manifest) throw new Error("Cannot snapshot a missing live run release manifest");
  await client.query("insert into show_revision_release_manifest_snapshots (tenant_id, show_revision_id, manifest, manifest_sha256) values ($1, $2, $3::jsonb, $4)", [input.tenantId, input.revisionId, JSON.stringify(manifest), manifest.sha256]);
  return manifest;
}

async function persistentManifest(client: PoolClient, runId: string): Promise<RunReleaseManifest | null> {
  const runResult = await client.query<ManifestRunRow>(
    `select r.id as run_id, sr.id as revision_id, s.name as show_name, sr.created_at as frozen_at,
      pv.id as product_id, pv.revision as product_revision, pv.approval_status as product_approval, pv.facts as product_facts,
      p.external_sku, p.name as product_name,
      policy.id as policy_id, policy.name as policy_name, policy.version as policy_version,
      policy.approval_status as policy_approval, policy.evidence_ref as policy_evidence_ref,
      policy.validation_summary as policy_validation_summary,
      snapshot.manifest_sha256 as frozen_manifest_sha256
     from live_runs r
     join show_revisions sr on sr.id = r.show_revision_id
     join shows s on s.id = sr.show_id
     left join show_revision_product_versions product_binding on product_binding.show_revision_id = sr.id and product_binding.slot_key = 'primary'
     left join product_versions pv on pv.id = product_binding.product_version_id
     left join products p on p.id = pv.product_id
     left join show_revision_policy_profiles policy_binding on policy_binding.show_revision_id = sr.id
     left join policy_profiles policy on policy.id = policy_binding.policy_profile_id
     left join show_revision_release_manifest_snapshots snapshot on snapshot.show_revision_id = sr.id
     where r.id = $1`,
    [runId]
  );
  const row = runResult.rows[0];
  if (!row) return null;
  const [models, assets] = await Promise.all([
    client.query<ManifestModelRow>(`select release.id, binding.component, release.name, release.version, release.approval_status, release.source_commit, release.artifact_hash, release.evidence_ref from show_revision_model_releases binding join model_releases release on release.id = binding.model_release_id where binding.show_revision_id = $1 order by binding.component`, [row.revision_id]),
    client.query<ManifestAssetRow>(`select asset.id, binding.kind, asset.name, asset.approval_status, asset.expires_at, asset.object_key, asset.checksum, asset.rights_scope, asset.source_ref from show_revision_media_assets binding join media_assets asset on asset.id = binding.media_asset_id where binding.show_revision_id = $1 order by binding.kind`, [row.revision_id])
  ]);
  const manifest = hashedManifest({
    runId: row.run_id,
    revisionId: row.revision_id,
    showName: row.show_name,
    frozenAt: new Date(row.frozen_at).toISOString(),
    product: row.product_id && row.product_revision && row.product_approval && row.external_sku && row.product_name && isProductFacts(row.product_facts) ? { id: row.product_id, revision: row.product_revision, approval: row.product_approval, externalSku: row.external_sku, name: row.product_name, facts: row.product_facts } : null,
    policy: row.policy_id && row.policy_name && row.policy_version && row.policy_approval && row.policy_evidence_ref !== null && row.policy_validation_summary !== null ? { id: row.policy_id, name: row.policy_name, version: row.policy_version, approval: row.policy_approval, evidenceRef: row.policy_evidence_ref, validationSummary: row.policy_validation_summary } : null,
    models: models.rows.map((model) => ({ id: model.id, component: model.component, name: model.name, version: model.version, approval: model.approval_status, sourceCommit: model.source_commit, artifactHash: model.artifact_hash, evidenceRef: model.evidence_ref })),
    assets: assets.rows.map((asset) => ({ id: asset.id, kind: asset.kind, name: asset.name, approval: asset.approval_status, expiresAt: asset.expires_at ? new Date(asset.expires_at).toISOString().slice(0, 10) : undefined, objectKey: asset.object_key, checksum: asset.checksum, rightsScope: asset.rights_scope, source: asset.source_ref }))
  });
  return { ...manifest, frozenSha256: row.frozen_manifest_sha256 ?? undefined };
}

async function demoManifest(context: RequestContext, runId: string): Promise<RunReleaseManifest | null> {
  if (runId !== "run_20261101_001") return null;
  const [assets, models, policies, product] = await Promise.all([listAssets(context), listModelReleases(context), listPolicyProfiles(context), findApprovedProductVersion(context, "pv_a102_v1")]);
  const policy = policies.find((item) => item.approval === "approved") ?? null;
  return hashedManifest({
    runId,
    revisionId: "show_revision_demo_v1",
    showName: "双十一预热场 · 美妆专场",
    frozenAt: "2026-11-01T08:00:00.000Z",
    product: product ? { id: product.id, revision: product.revision, approval: product.status, externalSku: "A-102", name: "氨基酸洁面慕斯", facts: product.facts } : null,
    policy: policy ? { id: policy.id, name: policy.name, version: policy.version, approval: policy.approval, evidenceRef: policy.evidenceRef, validationSummary: policy.validationSummary } : null,
    models: models.filter((item) => requiredProductionReleaseComponents.includes(item.component)).map((item) => ({ id: item.id, component: item.component, name: item.name, version: item.version, approval: item.approval, sourceCommit: item.sourceCommit, artifactHash: item.artifactHash, evidenceRef: item.evidenceRef })),
    assets: assets.filter((item) => requiredLiveAssetKinds.includes(item.kind)).map((item) => ({ id: item.id, kind: item.kind, name: item.name, approval: item.approval, expiresAt: item.expiresAt, objectKey: item.objectKey, checksum: item.checksum, rightsScope: item.rightsScope, source: item.source }))
  });
}

function hashedManifest(manifest: Omit<RunReleaseManifest, "sha256" | "frozenSha256">): RunReleaseManifest {
  return { ...manifest, sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}

function isProductFacts(value: unknown): value is ProductFacts {
  return value !== null && typeof value === "object" && "sourceRef" in value && "sourceSyncedAt" in value && "validFrom" in value;
}
