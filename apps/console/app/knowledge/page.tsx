import { AccessDenied } from "@/components/access-denied";
import { KnowledgeWorkspace } from "@/components/knowledge-workspace";
import { authorizedPageRequestContext } from "@/lib/control-plane/page-context";
import { listProducts } from "@/lib/catalog";
import { listKnowledgeEntries } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const actor = await authorizedPageRequestContext(["admin", "operator", "reviewer", "analyst"], { tenantWide: true });
  if (!actor) return <AccessDenied />;
  const [entries, products] = await Promise.all([listKnowledgeEntries(actor), listProducts(actor)]);
  return <KnowledgeWorkspace
    initialEntries={entries}
    products={products.map(({ id, name, externalSku }) => ({ id, name, externalSku }))}
    actorId={actor.actorId}
    canManage={actor.role === "admin" || actor.role === "operator"}
    canApprove={actor.role === "admin" || actor.role === "reviewer"}
  />;
}
