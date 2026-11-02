import Link from "next/link";
import { ArrowLeft, Gauge } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { EntitlementWorkspace } from "@/components/entitlement-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listEntitlements } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "analyst"]);
  if (!actor) return <AccessDenied />;
  const entitlements = await listEntitlements(actor);
  return <main className="usage-page"><header className="usage-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>商业额度</p><h1>租户用量与权益</h1><span>仅已配置的额度参与开播拦截；直播分钟由私网 worker 以幂等分钟桶记录，不替代最终计费结算。</span></div><Gauge size={24} /></header><EntitlementWorkspace initialEntitlements={entitlements} canManage={actor.role === "admin"} /></main>;
}
