import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createKnowledgeEntry, knowledgeEntryErrorResponse, listKnowledgeEntries, parseKnowledgeEntryInput } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listKnowledgeEntries(context) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    const input = parseKnowledgeEntryInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_knowledge_entry" }, { status: 400 });
    return Response.json({ data: await createKnowledgeEntry(context, input) }, { status: 201 });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}
