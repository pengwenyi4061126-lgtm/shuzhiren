import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { readBoundedJson } from "@/lib/bounded-json";
import { setEntitlement, type EntitlementCode } from "@/lib/entitlements";

export const dynamic = "force-dynamic";
const codes = new Set<EntitlementCode>(["max_concurrent_live_runs", "monthly_live_minutes"]);

export async function PUT(request: Request, context: RouteContext<"/api/v1/entitlements/[code]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    const { code } = await context.params;
    if (!codes.has(code as EntitlementCode)) return Response.json({ error: "unknown_entitlement" }, { status: 404 });
    const body = (await readBoundedJson(request) ?? {}) as { limitValue?: unknown; effectiveFrom?: unknown; effectiveUntil?: unknown };
    const limitValue = body.limitValue;
    if (typeof limitValue !== "number" || !Number.isSafeInteger(limitValue) || (body.effectiveFrom !== undefined && typeof body.effectiveFrom !== "string") || (body.effectiveUntil !== undefined && typeof body.effectiveUntil !== "string")) return Response.json({ error: "invalid_entitlement_input" }, { status: 400 });
    return Response.json({ data: await setEntitlement(actor, { code: code as EntitlementCode, limitValue, effectiveFrom: body.effectiveFrom, effectiveUntil: body.effectiveUntil }) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "entitlement_rejected" }, { status: error.status });
    throw error;
  }
}
