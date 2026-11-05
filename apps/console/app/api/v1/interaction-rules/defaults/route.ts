import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createDefaultInteractionRules, interactionRuleErrorResponse } from "@/lib/interaction-rules";

export const dynamic = "force-dynamic";

// 一键创建默认规则: idempotent per tenant; created rules are pending approval.
export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    const result = await createDefaultInteractionRules(context);
    return Response.json({ data: result }, { status: result.created.length ? 201 : 200 });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_defaults_rejected");
  }
}
