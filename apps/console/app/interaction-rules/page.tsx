import { AccessDenied } from "@/components/access-denied";
import { InteractionRuleWorkspace } from "@/components/interaction-rule-workspace";
import { listRuns } from "@/lib/control-plane/store";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listInteractionRules } from "@/lib/interaction-rules";
export const dynamic = "force-dynamic";
export default async function InteractionRulesPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const [rules, runs] = await Promise.all([listInteractionRules(actor), listRuns(actor)]);
  return <InteractionRuleWorkspace initialRules={rules} runs={runs.map((run) => ({ id: run.id, showName: run.showName, state: run.state }))} canManage={actor.role === "admin" || actor.role === "operator"} canApprove={actor.role === "admin" || actor.role === "reviewer"} />;
}
