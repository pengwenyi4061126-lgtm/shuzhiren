import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { resolveSettlementException } from "@/lib/settlements";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/settlement-exceptions/[exceptionId]/resolve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const body = (await readBoundedJson(request) ?? {}) as { resolution?: unknown; evidenceRef?: unknown };
    if (typeof body.resolution !== "string" || typeof body.evidenceRef !== "string") return Response.json({ error: "resolution_and_evidence_ref_are_required" }, { status: 400 });
    const { exceptionId } = await context.params;
    return Response.json({ data: await resolveSettlementException(actor, exceptionId, body.resolution, body.evidenceRef) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "settlement_exception_rejected" }, { status: error.status });
    throw error;
  }
}
