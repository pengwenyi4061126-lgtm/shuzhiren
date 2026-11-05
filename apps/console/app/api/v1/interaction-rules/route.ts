import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createInteractionRule, interactionRuleErrorResponse, listInteractionRules, parseInteractionRuleInput } from "@/lib/interaction-rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listInteractionRules(context) });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_rejected");
  }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    const input = parseInteractionRuleInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_interaction_rule" }, { status: 400 });
    // createInteractionRule writes interaction_rule.created in the rule's transaction; the rule starts pending.
    return Response.json({ data: await createInteractionRule(context, input) }, { status: 201 });
  } catch (error) {
    return interactionRuleErrorResponse(error, "interaction_rule_rejected");
  }
}
