import Link from "next/link";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { ProgramWorkspace } from "@/components/program-workspace";
import { ProgramRevisionWorkspace } from "@/components/program-revision-workspace";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { getShowProgram } from "@/lib/show-program";
import { listProgramRevisionRequests } from "@/lib/show-program-revisions";
import { getRun } from "@/lib/control-plane/store";

export default async function ProgramPage(props: PageProps<"/shows/[runId]/program">) {
  const { runId } = await props.params;
  const actor = await pageRequestContext();
  const run = await getRun(actor, runId);
  const [program, revisionRequests] = await Promise.all([getShowProgram(actor, runId), listProgramRevisionRequests(actor, runId)]);
  if (!run || !program) return <main className="empty-page"><h1>节目单不存在</h1><Link href="/">返回指挥台</Link></main>;

  const canManage = actor.role === "admin" || actor.role === "operator";
  const canApprove = actor.role === "admin" || actor.role === "reviewer";
  return <main className="program-page"><header className="program-header"><div><Link className="back-link" href={`/shows/${run.id}/preflight`}><ArrowLeft size={16} />返回预检</Link><p>场次编排</p><h1>{run.showName}</h1><span>{program.revisionId} · {program.editable ? "草稿可编辑" : "节目事实已冻结"}</span></div><div className="program-summary"><BadgeCheck size={18} />{program.status === "approved" ? "节目版本已批准" : program.editable ? "草稿节目单" : "等待审核"}</div></header><section className="program-layout"><ProgramWorkspace runId={run.id} program={program} canManage={canManage} canApprove={canApprove} /><aside className="program-panel program-rules"><h2>运行约束</h2><ul><li>预制讲品必须引用批准的商品事实版本。</li><li>实时互动只允许低风险、证据充分的问题。</li><li>推理、音频或推流异常立即切入备用节目。</li><li>高风险问题不进入数字人话术，转人工场控。</li></ul><Link className="program-preflight-link" href={`/shows/${run.id}/preflight`}>查看开播预检</Link><Link className="program-events-link" href={`/shows/${run.id}/events`}>查看场次时间线</Link></aside></section>{!program.editable ? <ProgramRevisionWorkspace runId={run.id} requests={revisionRequests} canManage={canManage} canApprove={canApprove} canCreate={run.state === "APPROVED" || run.state === "PREFLIGHT"} /> : null}</main>;
}
