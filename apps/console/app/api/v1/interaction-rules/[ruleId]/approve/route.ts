import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveInteractionRule, interactionRuleErrorResponse } from "@/lib/interaction-rules";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/interaction-rules/[ruleId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { ruleId } = await context.params;
    // Every template passes the policy engine first; approval writes interaction_rule.approved in its transaction.
    return Response.json({ data: await approveInteractionRule(actor, ruleId) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_approval_rejected");
  }
}
