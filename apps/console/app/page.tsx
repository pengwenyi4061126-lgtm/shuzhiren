import { ControlRoom } from "@/components/control-room";
import { ArrowRight, Clapperboard } from "lucide-react";
import Link from "next/link";
import { pageRequestContext } from "@/lib/control-plane/page-context";
import { listRuns } from "@/lib/control-plane/store";
import { listInteractions } from "@/lib/interactions";
import { getTelemetry, listAlerts } from "@/lib/monitoring";
import { getShowProgram } from "@/lib/show-program";

export const dynamic = "force-dynamic";

export default async function Page() {
  const actor = await pageRequestContext();
  const runs = await listRuns(actor);
  const run = runs.find((candidate) => candidate.state === "LIVE" || candidate.state === "DEGRADED") ?? runs[0];
  if (!run) return <main className="empty-page dashboard-empty">
    <span className="dashboard-empty-icon"><Clapperboard size={22} /></span>
    <p className="dashboard-empty-kicker">SHUZHIREN STUDIO</p>
    <h1>从一个内容项目开始</h1>
    <p className="dashboard-empty-copy">整理素材与商品信息，生成一份可审核的内容，再选择制作录播视频、准备直播场次，或同时完成两种输出。</p>
    <div className="dashboard-empty-actions">
      <Link className="dashboard-empty-primary" href="/studio">进入内容工坊 <ArrowRight size={16} /></Link>
      <Link className="dashboard-empty-secondary" href="/shows">查看场次排期</Link>
    </div>
  </main>;
  const [telemetry, alerts, interactions, program] = await Promise.all([
    getTelemetry(actor, run.id),
    listAlerts(actor, run.id),
    listInteractions(actor, run.id, "queued"),
    getShowProgram(actor, run.id)
  ]);
  return <ControlRoom initialRun={run} initialProgram={program} initialTelemetry={telemetry} initialAlerts={alerts.filter((alert) => alert.status === "open")} initialInteractions={interactions} canOperate={actor.role === "admin" || actor.role === "operator"} canReview={actor.role === "admin" || actor.role === "reviewer"} />;
}
