import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { IncidentList } from "@/components/incident-list";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listIncidents } from "@/lib/incidents";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const incidents = await listIncidents(actor);
  return <main className="incidents-page"><header className="incidents-header"><div><p>值班处置</p><h1>事故单</h1><span>将运行告警转化为有责任人、处置结论和审计记录的工作项。</span></div><ClipboardCheck size={24} /></header><IncidentList initialIncidents={incidents} canResolve={actor.role === "admin" || actor.role === "operator"} /><Link className="catalog-back" href="/monitoring">返回运行监控</Link></main>;
}
