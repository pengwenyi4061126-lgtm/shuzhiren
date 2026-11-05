import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAuditEvent, recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { assertLiveRunAccess, assertLiveRunAccessInTransaction } from "@/lib/control-plane/run-access";
import { databasePool, withTenantTransaction } from "@/lib/database";

export type ProgramSegmentKind = "prepared_product" | "interactive" | "fallback" | "human_handoff";
export type ProgramSegment = {
  id: string;
  position: number;
  kind: ProgramSegmentKind;
  title: string;
  durationSeconds: number;
  productVersionId?: string;
  purpose: string;
  runtimeScript?: string;
  fallback: boolean;
};
export type ProgramSegmentInput = Pick<ProgramSegment, "kind" | "title" | "durationSeconds" | "purpose" | "runtimeScript">;

export type ShowProgram = { runId: string; tenantId: string; revisionId: string; status: "draft" | "approved" | "rejected"; editable: boolean; segments: ProgramSegment[] };
type ProgramStore = { programs: Map<string, ShowProgram> };
type PersistentProgramRow = {
  run_id: string;
  tenant_id: string;
  revision_id: string;
  approval_status: ShowProgram["status"];
  run_state: string;
  segment_id: string | null;
  position: number | null;
  kind: ProgramSegmentKind | null;
  title: string | null;
  duration_seconds: number | null;
  product_version_id: string | null;
  purpose: string | null;
  runtime_script: string | null;
  is_fallback: boolean | null;
};

declare global { var shuzhirenProgramStore: ProgramStore | undefined; }

function programStore(): ProgramStore {
  globalThis.shuzhirenProgramStore ??= { programs: new Map([["run_20261101_001", {
    runId: "run_20261101_001",
    tenantId: "tenant_demo",
    revisionId: "show_revision_demo_v1",
    status: "approved",
    editable: false,
    segments: [
      { id: "10000000-0000-4000-8000-000000000001", position: 1, kind: "prepared_product", title: "开场与福利说明", durationSeconds: 85, productVersionId: "pv_a102_v1", purpose: "预制讲品，锁定价格与赠品口径", runtimeScript: "欢迎来到直播间。今天的价格、赠品和适用范围以已审核商品卡为准。", fallback: false },
      { id: "10000000-0000-4000-8000-000000000002", position: 2, kind: "prepared_product", title: "洁面慕斯卖点讲解", durationSeconds: 210, productVersionId: "pv_a102_v1", purpose: "预制商品讲解片段", runtimeScript: "现在讲解洁面慕斯的已审核成分、使用方法和活动权益；不作未审核功效承诺。", fallback: false },
      { id: "10000000-0000-4000-8000-000000000003", position: 3, kind: "interactive", title: "受控互动窗口", durationSeconds: 120, productVersionId: "pv_a102_v1", purpose: "仅处理低风险、可追溯问答", runtimeScript: "现在进入受控互动环节。只回答已审核商品资料中的低风险问题，其他问题转人工。", fallback: false },
      { id: "10000000-0000-4000-8000-000000000004", position: 4, kind: "fallback", title: "成分与使用方式备用片段", durationSeconds: 150, productVersionId: "pv_a102_v1", purpose: "推理或网络异常时立即切换", fallback: true },
      { id: "10000000-0000-4000-8000-000000000005", position: 5, kind: "human_handoff", title: "人工场控接管", durationSeconds: 0, purpose: "高风险承诺、投诉与异常处理", fallback: true }
    ]
  }]]) };
  return globalThis.shuzhirenProgramStore;
}

export async function getShowProgram(context: RequestContext, runId: string) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) {
    const program = programStore().programs.get(runId);
    return program?.tenantId === context.tenantId ? program : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => loadPersistentProgram(client, runId));
}

export async function getShowProgramInTransaction(client: PoolClient, context: RequestContext, runId: string) {
  await assertLiveRunAccessInTransaction(client, context, runId);
  return loadPersistentProgram(client, runId);
}

async function loadPersistentProgram(client: PoolClient, runId: string) {
  const result = await client.query<PersistentProgramRow>(
    `select r.id as run_id, r.tenant_id, sr.id as revision_id, sr.approval_status, r.state as run_state,
      s.id as segment_id, s.position, s.kind, s.title, s.duration_seconds,
      s.product_version_id, s.purpose, s.runtime_script, s.is_fallback
     from live_runs r
     join show_revisions sr on sr.id = r.show_revision_id
     left join show_revision_segments s on s.show_revision_id = sr.id
     where r.id = $1
     order by s.position asc nulls last`,
    [runId]
  );
  return result.rows[0] ? persistentProgram(result.rows) : null;
}

export function registerDemoProgram(program: ShowProgram) {
  programStore().programs.set(program.runId, program);
}

export async function replaceShowProgram(context: RequestContext, runId: string, input: ProgramSegmentInput[]) {
  await assertLiveRunAccess(context, runId);
  if (!databasePool()) {
    const program = programStore().programs.get(runId);
    if (!program || program.tenantId !== context.tenantId) return null;
    if (!program.editable) throw new Response("Show program is locked after review submission", { status: 409 });
    const productVersionId = program.segments.find((segment) => segment.productVersionId)?.productVersionId;
    const beforeSha256 = programHash(program.segments);
    program.segments = normalizeProgramSegments(input, productVersionId);
    await recordAuditEvent(context, { type: "show_program.updated", resource: "show_revision", resourceId: program.revisionId, detail: { runId, beforeSha256, afterSha256: programHash(program.segments), segmentCount: program.segments.length } });
    return program;
  }

  return withTenantTransaction(context.tenantId, async (client) => {
    const run = await loadEditableRun(client, runId);
    if (!run) return null;
    if (run.state !== "DRAFT" || run.approvalStatus !== "draft") throw new Response("Show program is locked after review submission", { status: 409 });
    const current = await loadSegments(client, run.revisionId);
    const segments = normalizeProgramSegments(input, run.productVersionId);
    await client.query("delete from show_revision_segments where show_revision_id = $1", [run.revisionId]);
    for (const segment of segments) {
      await client.query("insert into show_revision_segments (tenant_id, show_revision_id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, is_fallback) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [context.tenantId, run.revisionId, segment.position, segment.kind, segment.title, segment.durationSeconds, segment.productVersionId ?? null, segment.purpose, segment.runtimeScript ?? null, segment.fallback]);
    }
    await recordAuditEventInTransaction(client, context, { type: "show_program.updated", resource: "show_revision", resourceId: run.revisionId, detail: { runId, beforeSha256: programHash(current), afterSha256: programHash(segments), segmentCount: segments.length } });
    return { runId, tenantId: context.tenantId, revisionId: run.revisionId, status: "draft" as const, editable: true, segments };
  });
}

export function updateDemoProgramLifecycle(runId: string, action: "submit_review" | "approve") {
  const program = programStore().programs.get(runId);
  if (!program) return;
  if (action === "submit_review") {
    validateStoredProgramSegments(program.segments, program.segments.find((segment) => segment.productVersionId)?.productVersionId);
    program.editable = false;
  }
  if (action === "approve") program.status = "approved";
}

export async function hasApprovedFallbackProgram(context: RequestContext, runId: string) {
  return hasApprovedFallback(await getShowProgram(context, runId));
}

export async function hasApprovedFallbackProgramInTransaction(client: PoolClient, context: RequestContext, runId: string) {
  return hasApprovedFallback(await getShowProgramInTransaction(client, context, runId));
}

function hasApprovedFallback(program: ShowProgram | null) {
  return Boolean(program?.status === "approved" && program.segments.some((segment) => segment.fallback));
}

export async function approveShowProgramInTransaction(client: PoolClient, context: RequestContext, runId: string, revisionId: string, productVersionId?: string) {
  const evidence = await validateShowProgramInTransaction(client, runId, revisionId, productVersionId);
  const actor = await client.query<{ id: string }>("select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id", [context.tenantId, context.actorId, context.actorName, context.role]);
  const updated = await client.query("update show_revisions set approval_status = 'approved', approved_by = $2, approved_at = now() where id = $1 and approval_status = 'draft' returning id", [revisionId, actor.rows[0].id]);
  if (!updated.rows[0]) throw new Response("Show program is not awaiting approval", { status: 409 });
  return evidence;
}

export async function validateShowProgramInTransaction(client: PoolClient, runId: string, revisionId: string, productVersionId?: string) {
  const segments = await loadSegments(client, revisionId);
  validateStoredProgramSegments(segments, productVersionId);
  return { runId, segmentCount: segments.length, sha256: programHash(segments) };
}

function persistentProgram(rows: PersistentProgramRow[]): ShowProgram {
  const first = rows[0];
  return {
    runId: first.run_id,
    tenantId: first.tenant_id,
    revisionId: first.revision_id,
    status: first.approval_status,
    editable: first.run_state === "DRAFT" && first.approval_status === "draft",
    segments: rows.flatMap((row) => row.segment_id && row.position && row.kind && row.title && row.duration_seconds !== null && row.purpose !== null && row.is_fallback !== null ? [{
      id: row.segment_id,
      position: row.position,
      kind: row.kind,
      title: row.title,
      durationSeconds: row.duration_seconds,
      productVersionId: row.product_version_id ?? undefined,
      purpose: row.purpose,
      runtimeScript: row.runtime_script ?? undefined,
      fallback: row.is_fallback
    }] : [])
  };
}

type EditableRun = { revisionId: string; state: string; approvalStatus: ShowProgram["status"]; productVersionId?: string };

async function loadEditableRun(client: PoolClient, runId: string): Promise<EditableRun | null> {
  const result = await client.query<{ revision_id: string; state: string; approval_status: ShowProgram["status"]; product_version_id: string | null }>(`select r.show_revision_id as revision_id, r.state, sr.approval_status, r.product_version_id from live_runs r join show_revisions sr on sr.id = r.show_revision_id where r.id = $1 for update of r, sr`, [runId]);
  const row = result.rows[0];
  return row ? { revisionId: row.revision_id, state: row.state, approvalStatus: row.approval_status, productVersionId: row.product_version_id ?? undefined } : null;
}

async function loadSegments(client: PoolClient, revisionId: string): Promise<ProgramSegment[]> {
  const result = await client.query<{ id: string; position: number; kind: ProgramSegmentKind; title: string; duration_seconds: number; product_version_id: string | null; purpose: string; runtime_script: string | null; is_fallback: boolean }>("select id, position, kind, title, duration_seconds, product_version_id, purpose, runtime_script, is_fallback from show_revision_segments where show_revision_id = $1 order by position asc", [revisionId]);
  return result.rows.map((row) => ({ id: row.id, position: row.position, kind: row.kind, title: row.title, durationSeconds: row.duration_seconds, productVersionId: row.product_version_id ?? undefined, purpose: row.purpose, runtimeScript: row.runtime_script ?? undefined, fallback: row.is_fallback }));
}

export function normalizeProgramSegments(input: ProgramSegmentInput[], productVersionId?: string): ProgramSegment[] {
  if (!productVersionId) throw new Response("A frozen product version is required", { status: 409 });
  if (!Array.isArray(input) || input.length < 2 || input.length > 20) throw new Response("A show program must contain between 2 and 20 segments", { status: 409 });
  const segments = input.map((segment, index) => {
    if (!isProgramSegmentKind(segment.kind) || typeof segment.title !== "string" || !segment.title.trim() || segment.title.trim().length > 160 || typeof segment.purpose !== "string" || !segment.purpose.trim() || segment.purpose.trim().length > 1000 || !Number.isInteger(segment.durationSeconds) || segment.durationSeconds < 0 || segment.durationSeconds > 3600) throw new Response("Show program contains an invalid segment", { status: 409 });
    if (segment.kind === "human_handoff" && segment.durationSeconds !== 0) throw new Response("Human handoff segments must use a zero duration", { status: 409 });
    if (segment.kind !== "human_handoff" && segment.durationSeconds === 0) throw new Response("Non-handoff segments require a positive duration", { status: 409 });
    const runtimeScript = typeof segment.runtimeScript === "string" ? segment.runtimeScript.trim() : undefined;
    const isRunnable = segment.kind === "prepared_product" || segment.kind === "interactive";
    if (isRunnable && (!runtimeScript || runtimeScript.length > 800)) throw new Response("Runnable program segments require a frozen runtime script of at most 800 characters", { status: 409 });
    if (!isRunnable && runtimeScript) throw new Response("Fallback and handoff segments cannot carry a runtime script", { status: 409 });
    return { id: `segment_${crypto.randomUUID()}`, position: index + 1, kind: segment.kind, title: segment.title.trim(), durationSeconds: segment.durationSeconds, productVersionId: segment.kind === "human_handoff" ? undefined : productVersionId, purpose: segment.purpose.trim(), runtimeScript, fallback: segment.kind === "fallback" || segment.kind === "human_handoff" };
  });
  if (!segments.some((segment) => segment.kind === "fallback") || !segments.some((segment) => segment.kind === "human_handoff")) throw new Response("A fallback and human handoff segment are required", { status: 409 });
  return segments;
}

function validateStoredProgramSegments(segments: ProgramSegment[], productVersionId?: string) {
  const normalized = normalizeProgramSegments(segments.map((segment) => ({ kind: segment.kind, title: segment.title, durationSeconds: segment.durationSeconds, purpose: segment.purpose, runtimeScript: segment.runtimeScript })), productVersionId);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.position !== index + 1 || segment.fallback !== normalized[index].fallback || segment.productVersionId !== normalized[index].productVersionId) throw new Response("Show program bindings are invalid", { status: 409 });
  }
}

function isProgramSegmentKind(value: unknown): value is ProgramSegmentKind {
  return value === "prepared_product" || value === "interactive" || value === "fallback" || value === "human_handoff";
}

export function programHash(segments: ProgramSegment[]) {
  return createHash("sha256").update(JSON.stringify(segments.map((segment) => ({ position: segment.position, kind: segment.kind, title: segment.title, durationSeconds: segment.durationSeconds, productVersionId: segment.productVersionId ?? null, purpose: segment.purpose, runtimeScript: segment.runtimeScript ?? null, fallback: segment.fallback })))).digest("hex");
}
