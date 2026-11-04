import Link from "next/link";
import { ArrowLeft, UsersRound } from "lucide-react";
import { AccessDenied } from "@/components/access-denied";
import { MembershipWorkspace } from "@/components/membership-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listChannelConnections } from "@/lib/channels";
import { listRuns } from "@/lib/control-plane/store";
import { listMemberships } from "@/lib/memberships";

export const dynamic = "force-dynamic";

export default async function MembershipsPage() {
  const actor = await authorizedPageRequestContext(["admin"]);
  if (!actor) return <AccessDenied />;
  const [memberships, channels, runs] = await Promise.all([listMemberships(actor), listChannelConnections(actor), listRuns(actor)]);
  return <main className="memberships-page"><header className="memberships-header"><div><Link className="back-link" href="/"><ArrowLeft size={16} />返回指挥台</Link><p>人员权限</p><h1>租户成员与角色</h1><span>授权以数据库中的有效成员关系为准，JWT 只验证身份和租户，不会覆盖本页设置；受限成员只可操作分配的频道及关联场次，或明确分配的场次。</span></div><UsersRound size={24} /></header><MembershipWorkspace initialMemberships={memberships} channels={channels} runs={runs} /></main>;
}
