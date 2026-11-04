import Link from "next/link";
import { ArrowLeft, Landmark } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { SettlementWorkspace } from "@/components/settlement-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listSettlementBatches } from "@/lib/settlements";

export const dynamic = "force-dynamic";

export default async function SettlementsPage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const batches = await listSettlementBatches(actor);
  return <main className="settlements-page"><header className="settlements-header"><div><Link className="back-link" href="/analytics"><ArrowLeft size={16} />返回经营数据</Link><p>财务核验</p><h1>平台结算对账</h1><span>运营事件用于估算，平台账单才是结算事实。账单来源与行项目不可改写，差异必须附证据结案。</span></div><Landmark size={25} /></header><SettlementWorkspace initialBatches={batches} canResolve={actor.role === "admin" || actor.role === "reviewer"} /></main>;
}
