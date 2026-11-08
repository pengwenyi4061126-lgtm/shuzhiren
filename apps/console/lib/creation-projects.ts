import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import { listAssets } from "@/lib/assets";
import { isProductFactsCurrent, listProducts, type ProductFacts } from "@/lib/catalog";
import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { listRuns } from "@/lib/control-plane/store";
import { scanProhibitedTermText } from "@/lib/prohibited-terms";
import { creationProjectScriptReviewSha256 } from "@/lib/creation-project-review";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type CreationOutputMode = "recording" | "live" | "both";
export type CreationProjectInput = { name: string; goal: string; audience: string; outputMode: CreationOutputMode; productVersionId: string; assetIds: string[]; script: string };
export type CreationProjectScriptReview = { sha256: string; productVersionId: string; reviewedBy: string; reviewedAt: string };
export type CreationProject = CreationProjectInput & { id: string; tenantId: string; assetIds: string[]; liveRunIds: string[]; revision: number; createdAt: string; updatedAt: string; scriptReview: CreationProjectScriptReview | null };

export function isCreationProjectInput(value: unknown): value is CreationProjectInput {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 200
    && typeof item.goal === "string" && item.goal.trim().length > 0 && item.goal.length <= 500
    && typeof item.audience === "string" && item.audience.trim().length > 0 && item.audience.length <= 300
    && (item.outputMode === "recording" || item.outputMode === "live" || item.outputMode === "both")
    && typeof item.productVersionId === "string" && item.productVersionId.length > 0 && item.productVersionId.length <= 128
    && Array.isArray(item.assetIds) && item.assetIds.length <= 20 && item.assetIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
    && typeof item.script === "string" && item.script.length <= 12000;
}

type ProjectRow = Omit<CreationProject, "assetIds" | "liveRunIds" | "createdAt" | "updatedAt" | "scriptReview"> & { scriptReviewSha256: string | null; scriptReviewProductVersionId: string | null; scriptReviewedBy: string | null; scriptReviewedAt: Date | string | null; created_at: Date | string; updated_at: Date | string };
type ProjectStore = { projects: Map<string, CreationProject> };

declare global { var shuzhirenCreationProjects: ProjectStore | undefined; }

function projectStore() {
  globalThis.shuzhirenCreationProjects ??= { projects: new Map() };
  return globalThis.shuzhirenCreationProjects;
}

export async function listCreationProjects(context: RequestContext) {
  requireTenantWideAccess(context);
  if (!databasePool()) return [...projectStore().projects.values()].filter((project) => project.tenantId === context.tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return withTenantTransaction(context.tenantId, async (client) => {
    const rows = (await client.query<ProjectRow>(
      `select id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at
       from creation_projects order by updated_at desc`
    )).rows;
    return loadProjectRelations(client, context.tenantId, rows);
  });
}

export async function createCreationProject(context: RequestContext, input: CreationProjectInput) {
  requireTenantWideAccess(context);
  const normalized = await validateReferences(context, input);
  if (!databasePool()) {
    const now = new Date().toISOString();
    const project: CreationProject = { ...normalized, id: `project_${crypto.randomUUID()}`, tenantId: context.tenantId, liveRunIds: [], revision: 1, createdAt: now, updatedAt: now, scriptReview: null };
    projectStore().projects.set(project.id, project);
    await recordAuditEvent(context, projectAudit("creation_project.created", project));
    return project;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    await assertReferencesInTransaction(client, context.tenantId, normalized);
    const row = (await client.query<ProjectRow>(
      `insert into creation_projects (tenant_id, name, goal, audience, output_mode, product_version_id, script)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at`,
      [context.tenantId, normalized.name, normalized.goal, normalized.audience, normalized.outputMode, normalized.productVersionId, normalized.script]
    )).rows[0];
    await replaceProjectAssets(client, context.tenantId, row.id, normalized.assetIds);
    const project = { ...mapProjectRow(row), assetIds: normalized.assetIds, liveRunIds: [] };
    await recordAuditEventInTransaction(client, context, projectAudit("creation_project.created", project));
    return project;
  });
}

export async function updateCreationProject(context: RequestContext, projectId: string, input: CreationProjectInput) {
  requireTenantWideAccess(context);
  const normalized = await validateReferences(context, input);
  if (!databasePool()) {
    const project = projectStore().projects.get(projectId);
    if (!project || project.tenantId !== context.tenantId) return null;
    const reviewUnchanged = project.script === normalized.script && project.productVersionId === normalized.productVersionId;
    const updated: CreationProject = { ...project, ...normalized, revision: project.revision + 1, updatedAt: new Date().toISOString(), scriptReview: reviewUnchanged ? project.scriptReview : null };
    projectStore().projects.set(projectId, updated);
    await recordAuditEvent(context, projectAudit("creation_project.updated", updated));
    return updated;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    await assertReferencesInTransaction(client, context.tenantId, normalized);
    const row = (await client.query<ProjectRow>(
      `update creation_projects set name = $3, goal = $4, audience = $5, output_mode = $6, product_version_id = $7, script = $8,
         revision = revision + 1, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at`,
      [context.tenantId, projectId, normalized.name, normalized.goal, normalized.audience, normalized.outputMode, normalized.productVersionId, normalized.script]
    )).rows[0];
    if (!row) return null;
    await replaceProjectAssets(client, context.tenantId, projectId, normalized.assetIds);
    const relations = await loadProjectRelations(client, context.tenantId, [row]);
    const project = relations[0];
    await recordAuditEventInTransaction(client, context, projectAudit("creation_project.updated", project));
    return project;
  });
}

export async function reviewCreationProjectScript(context: RequestContext, projectId: string) {
  requireTenantWideAccess(context);
  let script: string;
  let productVersionId: string;

  if (!databasePool()) {
    const project = projectStore().projects.get(projectId);
    if (!project || project.tenantId !== context.tenantId) return null;
    if (project.script.length > 4000) throw new Response("Project script exceeds the review limit", { status: 422, statusText: "project_script_too_long" });
    await validateReferences(context, project);
    script = project.script;
    productVersionId = project.productVersionId;
  } else {
    const candidate = await withTenantTransaction(context.tenantId, async (client) => (await client.query<{ productVersionId: string; script: string; facts: unknown }>(
      `select project.product_version_id as "productVersionId", project.script, version.facts
       from creation_projects project join product_versions version on version.tenant_id = project.tenant_id and version.id = project.product_version_id
       where project.tenant_id = $1 and project.id = $2 and version.approval_status = 'approved'`,
      [context.tenantId, projectId]
    )).rows[0] ?? null, { readOnly: true });
    if (!candidate) return null;
    if (candidate.script.length > 4000) throw new Response("Project script exceeds the review limit", { status: 422, statusText: "project_script_too_long" });
    if (!isProductFactsCurrent(candidate.facts as Parameters<typeof isProductFactsCurrent>[0])) throw new Response("Current approved product facts are required", { status: 409, statusText: "approved_product_facts_required" });
    script = candidate.script;
    productVersionId = candidate.productVersionId;
  }

  const scriptSha256 = creationProjectScriptReviewSha256(productVersionId, script);
  const scan = await scanProhibitedTermText(context, script);
  if (scan.findings.some((finding) => finding.severity === "block")) throw new Response("Script contains blocking prohibited terms", { status: 422, statusText: "script_prohibited_terms_blocked" });
  const reviewedAt = new Date().toISOString();

  if (!databasePool()) {
    const current = projectStore().projects.get(projectId);
    if (!current || current.tenantId !== context.tenantId) return null;
    if (creationProjectScriptReviewSha256(current.productVersionId, current.script) !== scriptSha256) throw new Response("Project script changed during review", { status: 409, statusText: "project_script_changed" });
    const updated: CreationProject = { ...current, scriptReview: { sha256: scriptSha256, productVersionId, reviewedBy: context.actorId, reviewedAt } };
    projectStore().projects.set(projectId, updated);
    await recordAuditEvent(context, scriptReviewAudit("creation_project.script_reviewed", updated));
    return updated;
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const current = (await client.query<ProjectRow & { facts: ProductFacts }>(
      `select project.id, project.tenant_id as "tenantId", project.name, project.goal, project.audience, project.output_mode as "outputMode", project.product_version_id as "productVersionId", project.script, project.revision, project.script_review_sha256 as "scriptReviewSha256", project.script_review_product_version_id as "scriptReviewProductVersionId", project.script_reviewed_by as "scriptReviewedBy", project.script_reviewed_at as "scriptReviewedAt", project.created_at, project.updated_at, version.facts
       from creation_projects project join product_versions version on version.tenant_id = project.tenant_id and version.id = project.product_version_id
       where project.tenant_id = $1 and project.id = $2 and version.approval_status = 'approved' for update of project`,
      [context.tenantId, projectId]
    )).rows[0];
    if (!current) return null;
    if (creationProjectScriptReviewSha256(current.productVersionId, current.script) !== scriptSha256 || current.productVersionId !== productVersionId) throw new Response("Project script changed during review", { status: 409, statusText: "project_script_changed" });
    if (!isProductFactsCurrent(current.facts)) throw new Response("Current approved product facts are required", { status: 409, statusText: "approved_product_facts_required" });
    const row = (await client.query<ProjectRow>(
      `update creation_projects set script_review_sha256 = $3, script_review_product_version_id = $4, script_reviewed_by = $5, script_reviewed_at = $6::timestamptz, updated_at = $6::timestamptz
       where tenant_id = $1 and id = $2
       returning id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at`,
      [context.tenantId, projectId, scriptSha256, productVersionId, context.actorId, reviewedAt]
    )).rows[0];
    const project = (await loadProjectRelations(client, context.tenantId, [row]))[0];
    await recordAuditEventInTransaction(client, context, scriptReviewAudit("creation_project.script_reviewed", project));
    return project;
  });
}

export async function revokeCreationProjectScriptReview(context: RequestContext, projectId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const current = projectStore().projects.get(projectId);
    if (!current || current.tenantId !== context.tenantId) return null;
    if (!current.scriptReview) return current;
    const updated = { ...current, scriptReview: null };
    projectStore().projects.set(projectId, updated);
    await recordAuditEvent(context, scriptReviewAudit("creation_project.script_review_revoked", updated));
    return updated;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<ProjectRow>(
      `update creation_projects set script_review_sha256 = null, script_review_product_version_id = null, script_reviewed_by = null, script_reviewed_at = null, updated_at = now()
       where tenant_id = $1 and id = $2 and script_review_sha256 is not null
       returning id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at`,
      [context.tenantId, projectId]
    )).rows[0];
    if (!row) return (await listCreationProjectsInTransaction(client, context.tenantId, projectId))[0] ?? null;
    const project = (await loadProjectRelations(client, context.tenantId, [row]))[0];
    await recordAuditEventInTransaction(client, context, scriptReviewAudit("creation_project.script_review_revoked", project));
    return project;
  });
}

export async function assertCreationProjectScriptReviewed(context: RequestContext, projectId: string, productVersionId: string) {
  requireTenantWideAccess(context);
  if (!databasePool()) {
    const project = projectStore().projects.get(projectId);
    if (!project || project.tenantId !== context.tenantId) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
    if (!project.scriptReview || project.productVersionId !== productVersionId || project.scriptReview.productVersionId !== productVersionId
      || project.scriptReview.sha256 !== creationProjectScriptReviewSha256(project.productVersionId, project.script)) {
      throw new Response("Current project script must be reviewed before creating outputs", { status: 409, statusText: "creation_project_script_not_reviewed" });
    }
    return;
  }
  await withTenantTransaction(context.tenantId, async (client) => {
    const row = (await client.query<{ productVersionId: string; script: string; reviewSha256: string | null; reviewProductVersionId: string | null }>(
      `select product_version_id as "productVersionId", script, script_review_sha256 as "reviewSha256", script_review_product_version_id as "reviewProductVersionId"
       from creation_projects where tenant_id = $1 and id = $2`, [context.tenantId, projectId]
    )).rows[0];
    if (!row) throw new Response("Content project was not found", { status: 404, statusText: "creation_project_not_found" });
    if (row.productVersionId !== productVersionId || row.reviewProductVersionId !== productVersionId || row.reviewSha256 !== creationProjectScriptReviewSha256(row.productVersionId, row.script)) {
      throw new Response("Current project script must be reviewed before creating outputs", { status: 409, statusText: "creation_project_script_not_reviewed" });
    }
  }, { readOnly: true });
}

export async function attachLiveOutput(context: RequestContext, projectId: string, runId: string) {
  requireTenantWideAccess(context);
  const runs = await listRuns(context);
  const run = runs.find((candidate) => candidate.id === runId && candidate.state === "DRAFT");
  if (!run) throw new Response("A draft live run in this tenant is required", { status: 409 });
  if (!databasePool()) {
    const project = projectStore().projects.get(projectId);
    if (!project || project.tenantId !== context.tenantId) return null;
    if (project.productVersionId !== run.productVersionId) throw new Response("Live run product version does not match the project", { status: 409 });
    if (!project.liveRunIds.includes(runId)) project.liveRunIds.push(runId);
    project.updatedAt = new Date().toISOString();
    await recordAuditEvent(context, { type: "creation_project.live_output_attached", resource: "creation_project", resourceId: project.id, detail: { runId, projectRevision: project.revision } });
    return project;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const draftRun = await client.query<{ product_version_id: string | null }>(
      "select product_version_id from live_runs where tenant_id = $1 and id = $2 and state = 'DRAFT' for update", [context.tenantId, runId]
    );
    if (!draftRun.rows[0] || draftRun.rows[0].product_version_id !== run.productVersionId) throw new Response("Draft live run changed before it could be attached", { status: 409 });
    const project = (await client.query<{ id: string; product_version_id: string; revision: number }>(
      "select id, product_version_id, revision from creation_projects where tenant_id = $1 and id = $2 for update", [context.tenantId, projectId]
    )).rows[0];
    if (!project) return null;
    if (project.product_version_id !== run.productVersionId) throw new Response("Live run product version does not match the project", { status: 409 });
    await client.query("insert into creation_project_live_outputs (tenant_id, project_id, live_run_id) values ($1, $2, $3) on conflict do nothing", [context.tenantId, projectId, runId]);
    await client.query("update creation_projects set updated_at = now() where tenant_id = $1 and id = $2", [context.tenantId, projectId]);
    await recordAuditEventInTransaction(client, context, { type: "creation_project.live_output_attached", resource: "creation_project", resourceId: projectId, detail: { runId, projectRevision: project.revision } });
    return (await listCreationProjectsInTransaction(client, context.tenantId, projectId))[0] ?? null;
  });
}

async function validateReferences(context: RequestContext, input: CreationProjectInput): Promise<CreationProjectInput> {
  const products = await listProducts(context);
  const version = products.flatMap((product) => product.versions).find((candidate) => candidate.id === input.productVersionId && candidate.status === "approved" && isProductFactsCurrent(candidate.facts));
  if (!version) throw new Response("An approved, current product facts version is required", { status: 409 });
  const assets = await listAssets(context);
  const ids = [...new Set(input.assetIds)];
  const selectedAssets = ids.map((id) => assets.find((asset) => asset.id === id));
  if (selectedAssets.some((asset) => !asset || asset.approval !== "approved" || (asset.expiresAt && Date.parse(`${asset.expiresAt}T23:59:59`) <= Date.now()))) {
    throw new Response("Only approved, non-expired tenant assets can be attached", { status: 409 });
  }
  return { ...input, name: input.name.trim(), goal: input.goal.trim(), audience: input.audience.trim(), productVersionId: version.id, assetIds: ids, script: input.script.trim() };
}

async function assertReferencesInTransaction(client: PoolClient, tenantId: string, input: CreationProjectInput) {
  const version = await client.query<{ facts: unknown }>(
    "select facts from product_versions where tenant_id = $1 and id = $2 and approval_status = 'approved'", [tenantId, input.productVersionId]
  );
  if (!version.rows[0] || !isProductFactsCurrent(version.rows[0].facts as Parameters<typeof isProductFactsCurrent>[0])) throw new Response("An approved, current product facts version is required", { status: 409 });
  if (!input.assetIds.length) return;
  const assets = await client.query<{ id: string }>(
    "select id from media_assets where tenant_id = $1 and id = any($2::uuid[]) and approval_status = 'approved' and (expires_at is null or expires_at >= current_date)",
    [tenantId, input.assetIds]
  );
  if (assets.rowCount !== input.assetIds.length) throw new Response("An attached asset is no longer approved or has expired", { status: 409 });
}

async function replaceProjectAssets(client: PoolClient, tenantId: string, projectId: string, assetIds: string[]) {
  await client.query("delete from creation_project_assets where tenant_id = $1 and project_id = $2", [tenantId, projectId]);
  for (const assetId of assetIds) await client.query("insert into creation_project_assets (tenant_id, project_id, media_asset_id) values ($1, $2, $3)", [tenantId, projectId, assetId]);
}

async function loadProjectRelations(client: PoolClient, tenantId: string, rows: ProjectRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [assets, outputs] = await Promise.all([
    client.query<{ project_id: string; media_asset_id: string }>("select project_id, media_asset_id from creation_project_assets where tenant_id = $1 and project_id = any($2::uuid[])", [tenantId, ids]),
    client.query<{ project_id: string; live_run_id: string }>("select project_id, live_run_id from creation_project_live_outputs where tenant_id = $1 and project_id = any($2::uuid[])", [tenantId, ids])
  ]);
  return rows.map((row) => ({
    ...mapProjectRow(row),
    assetIds: assets.rows.filter((asset) => asset.project_id === row.id).map((asset) => asset.media_asset_id),
    liveRunIds: outputs.rows.filter((output) => output.project_id === row.id).map((output) => output.live_run_id)
  }));
}

async function listCreationProjectsInTransaction(client: PoolClient, tenantId: string, projectId: string) {
  const rows = (await client.query<ProjectRow>(
    `select id, tenant_id as "tenantId", name, goal, audience, output_mode as "outputMode", product_version_id as "productVersionId", script, revision, script_review_sha256 as "scriptReviewSha256", script_review_product_version_id as "scriptReviewProductVersionId", script_reviewed_by as "scriptReviewedBy", script_reviewed_at as "scriptReviewedAt", created_at, updated_at
     from creation_projects where tenant_id = $1 and id = $2`, [tenantId, projectId]
  )).rows;
  return loadProjectRelations(client, tenantId, rows);
}

function mapProjectRow(row: ProjectRow) {
  const scriptReview = row.scriptReviewSha256 && row.scriptReviewProductVersionId && row.scriptReviewedBy && row.scriptReviewedAt
    ? { sha256: row.scriptReviewSha256, productVersionId: row.scriptReviewProductVersionId, reviewedBy: row.scriptReviewedBy, reviewedAt: new Date(row.scriptReviewedAt).toISOString() }
    : null;
  return { id: row.id, tenantId: row.tenantId, name: row.name, goal: row.goal, audience: row.audience, outputMode: row.outputMode, productVersionId: row.productVersionId, assetIds: [], liveRunIds: [], script: row.script, revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), scriptReview };
}

function projectAudit(type: "creation_project.created" | "creation_project.updated", project: CreationProject) {
  const contentHash = createHash("sha256").update(JSON.stringify({ name: project.name, goal: project.goal, audience: project.audience, outputMode: project.outputMode, productVersionId: project.productVersionId, assetIds: [...project.assetIds].sort(), script: project.script })).digest("hex");
  return { type, resource: "creation_project", resourceId: project.id, detail: { revision: project.revision, contentSha256: contentHash, assetCount: project.assetIds.length, outputMode: project.outputMode } };
}

function scriptReviewAudit(type: "creation_project.script_reviewed" | "creation_project.script_review_revoked", project: CreationProject) {
  return { type, resource: "creation_project", resourceId: project.id, detail: { productVersionId: project.productVersionId, scriptSha256: project.scriptReview?.sha256 ?? null, reviewed: project.scriptReview !== null } };
}
