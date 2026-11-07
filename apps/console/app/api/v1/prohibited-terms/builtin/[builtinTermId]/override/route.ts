import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { parseProhibitedTermInput, prohibitedTermErrorResponse, requestBuiltinTermOverride } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, route: RouteContext<"/api/v1/prohibited-terms/builtin/[builtinTermId]/override">) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin"]);
    const input = parseProhibitedTermInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_prohibited_term_override" }, { status: 400 });
    const { builtinTermId } = await route.params;
    return Response.json({ data: await requestBuiltinTermOverride(context, builtinTermId, input) }, { status: 201 });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_override_rejected"); }
}
