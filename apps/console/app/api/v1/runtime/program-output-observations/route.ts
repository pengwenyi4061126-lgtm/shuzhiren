import { readBoundedJson } from "@/lib/bounded-json";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { getRun } from "@/lib/control-plane/store";
import { isProgramOutputObservationInput, recordProgramOutputObservation, verifyProgramOutputAttestation } from "@/lib/program-output-observations";
import { requireProgramOutputObservationService } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid_program_output_observation" }, { status: 400 });
    const tenantId = (body as Record<string, unknown>).tenantId;
    if (typeof tenantId !== "string" || !isProgramOutputObservationInput(body)) return Response.json({ error: "invalid_program_output_observation" }, { status: 400 });
    requireProgramOutputObservationService(request, tenantId);
    const context: RequestContext = { tenantId, actorId: "runtime-service", actorName: "运行时观测服务", role: "operator" };
    const run = await getRun(context, body.runId);
    if (!run) return Response.json({ error: "live_run_not_found" }, { status: 404 });
    verifyProgramOutputAttestation(tenantId, body);
    const result = await recordProgramOutputObservation(context, body);
    return Response.json({ data: result }, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "program_output_observation_rejected" }, { status: error.status });
    throw error;
  }
}
