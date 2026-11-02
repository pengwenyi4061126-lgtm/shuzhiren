import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listEntitlements } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator", "analyst"]);
  return Response.json({ data: await listEntitlements(context) });
}
