import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { parseProhibitedTermInput, prohibitedTermErrorResponse, retireProhibitedTerm, updateProhibitedTerm } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, route: RouteContext<"/api/v1/prohibited-terms/[termId]">) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin"]);
    const input = parseProhibitedTermInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_prohibited_term" }, { status: 400 });
    const { termId } = await route.params;
    return Response.json({ data: await updateProhibitedTerm(context, termId, input) });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_rejected"); }
}

export async function DELETE(request: Request, route: RouteContext<"/api/v1/prohibited-terms/[termId]">) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin"]);
    const body = await readBoundedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { reason?: unknown }).reason !== "string") return Response.json({ error: "invalid_prohibited_term_reason" }, { status: 400 });
    const { termId } = await route.params;
    return Response.json({ data: await retireProhibitedTerm(context, termId, (body as { reason: string }).reason) });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_rejected"); }
}
