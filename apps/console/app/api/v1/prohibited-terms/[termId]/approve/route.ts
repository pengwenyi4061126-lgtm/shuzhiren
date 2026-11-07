import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveProhibitedTermRevision, prohibitedTermErrorResponse } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export async function POST(request: Request, route: RouteContext<"/api/v1/prohibited-terms/[termId]/approve">) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "reviewer"]);
    const { termId } = await route.params;
    return Response.json({ data: await approveProhibitedTermRevision(context, termId) });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_approval_rejected"); }
}
