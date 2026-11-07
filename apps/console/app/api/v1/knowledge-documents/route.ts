import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { importKnowledgeDocument, knowledgeEntryErrorResponse, listKnowledgeDocuments, parseKnowledgeDocumentInput } from "@/lib/knowledge-base";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listKnowledgeDocuments(context) });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    const input = parseKnowledgeDocumentInput(await readBoundedJson(request, 512 * 1024));
    if (!input) return Response.json({ error: "invalid_knowledge_document" }, { status: 400 });
    return Response.json({ data: await importKnowledgeDocument(context, input) }, { status: 201 });
  } catch (error) { return knowledgeEntryErrorResponse(error); }
}
