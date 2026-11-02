import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listRecordings } from "@/lib/recordings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator", "analyst"]);
  return Response.json({ data: await listRecordings(context) });
}
