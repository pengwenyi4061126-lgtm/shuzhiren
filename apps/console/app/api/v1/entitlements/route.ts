import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listEntitlements } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "analyst"]);
    return Response.json({ data: await listEntitlements(context) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "entitlement_rejected" }, { status: error.status });
    throw error;
  }
}
