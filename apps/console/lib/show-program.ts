import type { RequestContext } from "@/lib/control-plane/auth-context";
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
  fallback: boolean;
};

export type ShowProgram = { runId: string; tenantId: string; revisionId: string; status: "draft" | "approved" | "rejected"; segments: ProgramSegment[] };
type ProgramStore = { programs: Map<string, ShowProgram> };
type PersistentProgramRow = {
  run_id: string;
  tenant_id: string;
  revision_id: string;
  approval_status: ShowProgram["status"];
  segment_id: string | null;
  position: number | null;
  kind: ProgramSegmentKind | null;
  title: string | null;
  duration_seconds: number | null;
  product_version_id: string | null;
  purpose: string | null;
  is_fallback: boolean | null;
};

declare global { var shuzhirenProgramStore: ProgramStore | undefined; }

function programStore(): ProgramStore {
  globalThis.shuzhirenProgramStore ??= { programs: new Map([["run_20261101_001", {
    runId: "run_20261101_001",
    tenantId: "tenant_demo",
    revisionId: "show_revision_demo_v1",
    status: "approved",
    segments: [
      { id: "segment_open", position: 1, kind: "prepared_product", title: "开场与福利说明", durationSeconds: 85, productVersionId: "pv_a102_v1", purpose: "预制讲品，锁定价格与赠品口径", fallback: false },
      { id: "segment_product", position: 2, kind: "prepared_product", title: "洁面慕斯卖点讲解", durationSeconds: 210, productVersionId: "pv_a102_v1", purpose: "预制商品讲解片段", fallback: false },
      { id: "segment_interactive", position: 3, kind: "interactive", title: "受控互动窗口", durationSeconds: 120, productVersionId: "pv_a102_v1", purpose: "仅处理低风险、可追溯问答", fallback: false },
      { id: "segment_fallback", position: 4, kind: "fallback", title: "成分与使用方式备用片段", durationSeconds: 150, productVersionId: "pv_a102_v1", purpose: "推理或网络异常时立即切换", fallback: true },
      { id: "segment_handoff", position: 5, kind: "human_handoff", title: "人工场控接管", durationSeconds: 0, purpose: "高风险承诺、投诉与异常处理", fallback: true }
    ]
  }]]) };
  return globalThis.shuzhirenProgramStore;
}

export async function getShowProgram(context: RequestContext, runId: string) {
  if (!databasePool()) {
    const program = programStore().programs.get(runId);
    return program?.tenantId === context.tenantId ? program : null;
  }
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PersistentProgramRow>(
      `select r.id as run_id, r.tenant_id, sr.id as revision_id, sr.approval_status,
        s.id as segment_id, s.position, s.kind, s.title, s.duration_seconds,
        s.product_version_id, s.purpose, s.is_fallback
       from live_runs r
       join show_revisions sr on sr.id = r.show_revision_id
       left join show_revision_segments s on s.show_revision_id = sr.id
       where r.id = $1
       order by s.position asc nulls last`,
      [runId]
    );
    return result.rows[0] ? persistentProgram(result.rows) : null;
  });
}

export function registerDemoProgram(program: ShowProgram) {
  programStore().programs.set(program.runId, program);
}

export async function hasApprovedFallbackProgram(context: RequestContext, runId: string) {
  const program = await getShowProgram(context, runId);
  return Boolean(program?.status === "approved" && program.segments.some((segment) => segment.fallback));
}

function persistentProgram(rows: PersistentProgramRow[]): ShowProgram {
  const first = rows[0];
  return {
    runId: first.run_id,
    tenantId: first.tenant_id,
    revisionId: first.revision_id,
    status: first.approval_status,
    segments: rows.flatMap((row) => row.segment_id && row.position && row.kind && row.title && row.duration_seconds !== null && row.purpose !== null && row.is_fallback !== null ? [{
      id: row.segment_id,
      position: row.position,
      kind: row.kind,
      title: row.title,
      durationSeconds: row.duration_seconds,
      productVersionId: row.product_version_id ?? undefined,
      purpose: row.purpose,
      fallback: row.is_fallback
    }] : [])
  };
}
