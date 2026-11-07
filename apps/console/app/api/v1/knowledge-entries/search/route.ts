import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { parseKnowledgeSearchInput, searchKnowledgeEntries, knowledgeEntryErrorResponse } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const input = parseKnowledgeSearchInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_knowledge_search" }, { status: 400 });
    return Response.json({ data: await searchKnowledgeEntries(context, input) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}
