import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleX, ShieldCheck } from "lucide-react";
import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { evaluateRunPreflight, getRun } from "@/lib/control-plane/store";

export default async function PreflightPage(props: PageProps<"/shows/[runId]/preflight">) {
  const { runId } = await props.params;
  const run = await getRun(demoRequestContext, runId);
  if (!run) return <main className="empty-page"><h1>场次不存在</h1><Link href="/">返回指挥台</Link></main>;
  const preflight = await evaluateRunPreflight(demoRequestContext, run);

  return (
    <main className="preflight-page">
      <header className="preflight-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>场次预检</p><h1>{run.showName}</h1><span>{run.revisionId}</span></div><div className={preflight.passed ? "preflight-summary passed" : "preflight-summary blocked"}>{preflight.passed ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}{preflight.passed ? "允许进入待开播" : "存在阻塞项"}</div></header>
      <section className="preflight-grid"><article className="preflight-panel"><div className="preflight-panel-head"><div><ShieldCheck size={18} /><h2>开播预检</h2></div><span>{preflight.checks.filter((item) => item.status === "passed").length} / {preflight.checks.length} 通过</span></div><div className="preflight-checks">{preflight.checks.map((check) => <div className="preflight-check" key={check.id}>{check.status === "passed" ? <CheckCircle2 className="pass-icon" size={19} /> : <CircleX className="block-icon" size={19} />}<div><strong>{check.label}</strong><p>{check.detail}</p></div><b className={check.status}>{check.status === "passed" ? "通过" : "阻塞"}</b></div>)}</div></article><aside className="preflight-panel preflight-context"><h2>发布上下文</h2><dl><div><dt>直播运行</dt><dd>{run.id}</dd></div><div><dt>商品事实版本</dt><dd>{run.productVersionId ?? "未绑定"}</dd></div><div><dt>租户</dt><dd>{run.tenantId}</dd></div><div><dt>追踪标识</dt><dd>{run.traceId}</dd></div><div><dt>AI 标识</dt><dd>{run.aiDisclosureEnabled ? "已启用" : "未启用"}</dd></div></dl><button className="publish-button" disabled={!preflight.passed} type="button">确认待开播</button></aside></section>
    </main>
  );
}
