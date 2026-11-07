import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { getKnowledgeEntry, knowledgeEntryErrorResponse, parseKnowledgeEntryPatch, retireKnowledgeEntry, updateKnowledgeEntry } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/v1/knowledge-entries/[entryId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
    const { entryId } = await context.params;
    return Response.json({ data: await getKnowledgeEntry(actor, entryId) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}

export async function PUT(request: Request, context: RouteContext<"/api/v1/knowledge-entries/[entryId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const patch = parseKnowledgeEntryPatch(await readBoundedJson(request));
    if (!patch) return Response.json({ error: "invalid_knowledge_entry_patch" }, { status: 400 });
    const { entryId } = await context.params;
    return Response.json({ data: await updateKnowledgeEntry(actor, entryId, patch) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext<"/api/v1/knowledge-entries/[entryId]">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin"]);
    const { entryId } = await context.params;
    return Response.json({ data: await retireKnowledgeEntry(actor, entryId) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}
