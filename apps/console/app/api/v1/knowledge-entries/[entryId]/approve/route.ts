import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { approveKnowledgeEntry, knowledgeEntryErrorResponse } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/knowledge-entries/[entryId]/approve">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "reviewer"]);
    const { entryId } = await context.params;
    return Response.json({ data: await approveKnowledgeEntry(actor, entryId) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}
