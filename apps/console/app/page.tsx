import { ControlRoom } from "@/components/control-room";
import { demoRequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { getTelemetry, listAlerts } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export default async function Page() {
  const run = await getRun(demoRequestContext, "run_20261101_001");
  if (!run) return <main className="empty-page"><h1>当前没有可操作的直播场次</h1></main>;
  const [telemetry, alerts] = await Promise.all([
    getTelemetry(demoRequestContext, run.id),
    listAlerts(demoRequestContext, run.id)
  ]);
  return <ControlRoom initialRun={run} initialTelemetry={telemetry} initialAlerts={alerts.filter((alert) => alert.status === "open")} />;
}
