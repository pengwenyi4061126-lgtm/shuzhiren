import Link from "next/link";
import { ArrowLeft, FileClock, ShieldCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { listAuditEvents, verifyAuditChain } from "@/lib/audit";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const actor = await authorizedPageRequestContext(["admin", "reviewer", "analyst"]);
  if (!actor) return <AccessDenied />;
  const [events, chain] = await Promise.all([listAuditEvents(actor), verifyAuditChain(actor)]);
  return <main className="audit-page">
    <header className="audit-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>审计中心</p><h1>操作与运行证据</h1><span>记录控制命令、媒体派发、审批和运行时告警，供场次复盘与权限核查。</span></div><div className="audit-summary"><span className={chain.verified ? "audit-chain-ok" : "audit-chain-risk"}><ShieldCheck size={16} />{chain.detail}</span><span className="audit-count"><ShieldCheck size={16} />{events.length} 条记录</span></div></header>
    <section className="audit-table" aria-label="审计事件"><div className="audit-row audit-labels"><span>时间</span><span>事件</span><span>操作者</span><span>资源</span><span>证据</span></div>{events.length ? events.map((event) => <article className="audit-row" key={event.id}><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time><strong>{event.type}</strong><span>{event.actorName}</span><span className="audit-resource">{event.resource}<small>{event.resourceId}</small></span><code>{JSON.stringify(event.detail)}</code></article>) : <div className="audit-empty"><FileClock size={21} />暂时没有可展示的审计记录</div>}</section>
  </main>;
}
