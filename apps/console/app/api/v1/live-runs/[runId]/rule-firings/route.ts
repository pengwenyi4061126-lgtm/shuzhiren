import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { interactionRuleErrorResponse, listInteractionRuleFirings } from "@/lib/interaction-rules";

export const dynamic = "force-dynamic";

// The newest 200 interaction rule firings of a run (outcome, template, text hash), for operators and audit.
export async function GET(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/rule-firings">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { runId } = await context.params;
    return Response.json({ data: await listInteractionRuleFirings(actor, runId) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "rule_firings_rejected");
  }
}
