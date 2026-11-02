import Link from "next/link";
import { Activity, ArrowLeft, BellRing, ClipboardList, MessageSquareText, RadioTower, ShieldCheck } from "lucide-react";
import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { listRunEvents, type RunEventCategory } from "@/lib/run-events";

export const dynamic = "force-dynamic";

const iconByCategory: Record<RunEventCategory, typeof Activity> = {
  command: ClipboardList,
  media: RadioTower,
  alert: BellRing,
  interaction: MessageSquareText,
  audit: ShieldCheck
};

export default async function RunEventsPage(props: PageProps<"/shows/[runId]/events">) {
  const { runId } = await props.params;
  const [run, events] = await Promise.all([getRun(demoRequestContext, runId), listRunEvents(demoRequestContext, runId)]);
  if (!run || !events) return <main className="empty-page"><h1>场次不存在</h1><Link href="/">返回指挥台</Link></main>;

  return <main className="run-events-page">
    <header className="run-events-header"><div><Link className="back-link" href={`/shows/${run.id}/program`}><ArrowLeft size={16} />返回节目单</Link><p>场次时间线</p><h1>{run.showName}</h1><span>控制命令、媒体执行、运行告警、互动处置与审计证据的统一记录。</span></div><span className="run-events-count"><Activity size={16} />{events.length} 条事件</span></header>
    <section className="run-events-list" aria-label="场次事件时间线">{events.length ? events.map((event) => { const Icon = iconByCategory[event.category]; return <article className="run-event" key={event.id}><div className={`run-event-icon ${event.category}`}><Icon size={16} /></div><div className="run-event-copy"><div><strong>{event.title}</strong>{event.state ? <span className={`run-event-state ${event.state}`}>{event.state}</span> : null}</div><p>{event.detail}</p></div><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time></article>; }) : <div className="run-events-empty"><Activity size={22} />当前场次还没有运行事件</div>}</section>
  </main>;
}
