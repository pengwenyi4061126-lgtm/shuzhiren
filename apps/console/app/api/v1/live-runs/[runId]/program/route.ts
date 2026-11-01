import { requestContextFrom } from "@/lib/control-plane/auth-context";
import { getShowProgram } from "@/lib/show-program";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/program">) {
  const actor = await requestContextFrom(request);
  const { runId } = await context.params;
  const program = await getShowProgram(actor, runId);
  return program ? Response.json({ data: program }) : Response.json({ error: "not_found" }, { status: 404 });
}
