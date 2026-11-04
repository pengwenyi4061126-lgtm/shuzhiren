import { ControlRoom } from "@/components/control-room";
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
  if (!run) return <main className="empty-page"><h1>当前没有可操作的直播场次</h1></main>;
  const [telemetry, alerts, interactions, program] = await Promise.all([
    getTelemetry(actor, run.id),
    listAlerts(actor, run.id),
    listInteractions(actor, run.id, "queued"),
    getShowProgram(actor, run.id)
  ]);
  return <ControlRoom initialRun={run} initialProgram={program} initialTelemetry={telemetry} initialAlerts={alerts.filter((alert) => alert.status === "open")} initialInteractions={interactions} canOperate={actor.role === "admin" || actor.role === "operator"} canReview={actor.role === "admin" || actor.role === "reviewer"} />;
}
