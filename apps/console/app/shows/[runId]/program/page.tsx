import Link from "next/link";
import { ArrowLeft, BadgeCheck, Clapperboard, ContactRound, MessageSquareText, ShieldAlert } from "lucide-react";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { getShowProgram, type ProgramSegmentKind } from "@/lib/show-program";
import { getRun } from "@/lib/control-plane/store";

const kindMeta: Record<ProgramSegmentKind, { label: string; icon: typeof Clapperboard }> = {
  prepared_product: { label: "预制讲品", icon: Clapperboard },
  interactive: { label: "受控互动", icon: MessageSquareText },
  fallback: { label: "备用节目", icon: ShieldAlert },
  human_handoff: { label: "人工接管", icon: ContactRound }
};

export default async function ProgramPage(props: PageProps<"/shows/[runId]/program">) {
  const { runId } = await props.params;
  const actor = await pageRequestContext();
  const run = await getRun(actor, runId);
  const program = await getShowProgram(actor, runId);
  if (!run || !program) return <main className="empty-page"><h1>节目单不存在</h1><Link href="/">返回指挥台</Link></main>;

  const totalSeconds = program.segments.reduce((total, segment) => total + segment.durationSeconds, 0);
  return <main className="program-page"><header className="program-header"><div><Link className="back-link" href={`/shows/${run.id}/preflight`}><ArrowLeft size={16} />返回预检</Link><p>场次编排</p><h1>{run.showName}</h1><span>{program.revisionId} · 已冻结节目事实</span></div><div className="program-summary"><BadgeCheck size={18} />{program.status === "approved" ? "节目版本已批准" : "草稿节目单"}</div></header><section className="program-layout"><article className="program-panel"><div className="program-panel-head"><div><h2>节目段落</h2><span>{program.segments.length} 个段落 · 可预制内容 {Math.floor(totalSeconds / 60)} 分 {totalSeconds % 60} 秒</span></div><b>单路 4090</b></div><ol className="program-list">{program.segments.map((segment) => { const meta = kindMeta[segment.kind]; const Icon = meta.icon; return <li className={`program-item ${segment.fallback ? "fallback" : ""}`} key={segment.id}><div className="segment-order">{segment.position}</div><div className="segment-kind"><Icon size={17} /><span>{meta.label}</span></div><div className="segment-copy"><strong>{segment.title}</strong><p>{segment.purpose}</p>{segment.productVersionId ? <small>商品事实版本：{segment.productVersionId}</small> : <small>不读取商品事实</small>}</div><div className="segment-duration">{segment.durationSeconds ? `${segment.durationSeconds}s` : "按人工结束"}</div>{segment.fallback ? <span className="fallback-tag">降级可用</span> : <span className="normal-tag">主节目</span>}</li>; })}</ol></article><aside className="program-panel program-rules"><h2>运行约束</h2><ul><li>预制讲品必须引用批准的商品事实版本。</li><li>实时互动只允许低风险、证据充分的问题。</li><li>推理、音频或推流异常立即切入备用节目。</li><li>高风险问题不进入数字人话术，转人工场控。</li></ul><Link className="program-preflight-link" href={`/shows/${run.id}/preflight`}>查看开播预检</Link><Link className="program-events-link" href={`/shows/${run.id}/events`}>查看场次时间线</Link></aside></section></main>;
}
