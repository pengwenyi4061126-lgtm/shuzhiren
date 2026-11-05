import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listPresets } from "@/lib/presets";

export const dynamic = "force-dynamic";

// Enabled platform presets (migration 082). The catalogue is the same for every tenant and holds no tenant data.
export async function GET(request: Request) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listPresets(actor) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "runtime_preset_rejected" }, { status: error.status });
    throw error;
  }
}
