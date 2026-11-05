import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { disableInteractionRule, getInteractionRule, interactionRuleErrorResponse, parseInteractionRulePatch, updateInteractionRule } from "@/lib/interaction-rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/interaction-rules/[ruleId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { ruleId } = await context.params;
    return Response.json({ data: await getInteractionRule(actor, ruleId) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_rejected");
  }
}

// A change of trigger, matching, templates, action or scope returns the rule to pending approval.
export async function PATCH(request: Request, context: RouteContext<"/api/v1/interaction-rules/[ruleId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const patch = parseInteractionRulePatch(await readBoundedJson(request));
    if (!patch) return Response.json({ error: "invalid_interaction_rule" }, { status: 400 });
    const { ruleId } = await context.params;
    return Response.json({ data: await updateInteractionRule(actor, ruleId, patch) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_rejected");
  }
}

// 停用: the rule is kept (its firings reference it) and disabled. The AI identity disclosure rule is refused.
export async function DELETE(request: Request, context: RouteContext<"/api/v1/interaction-rules/[ruleId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { ruleId } = await context.params;
    return Response.json({ data: await disableInteractionRule(actor, ruleId) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_rejected");
  }
}
