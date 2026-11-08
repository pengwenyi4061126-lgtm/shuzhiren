import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { prohibitedTermErrorResponse, scanProhibitedTermText } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";
const scanContexts = new Set(["script", "template", "faq", "overlay", "reply"]);

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    const body = await readBoundedJson(request, 32 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid_prohibited_term_scan" }, { status: 400 });
    const { text, context: scanContext } = body as { text?: unknown; context?: unknown };
    if (typeof text !== "string" || text.length > 4000 || !scanContexts.has(String(scanContext))) return Response.json({ error: "invalid_prohibited_term_scan" }, { status: 422 });
    return Response.json({ data: await scanProhibitedTermText(context, text) });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_scan_rejected"); }
}
