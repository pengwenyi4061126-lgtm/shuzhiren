import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createProhibitedTerm, listProhibitedTerms, parseProhibitedTermInput, prohibitedTermErrorResponse } from "@/lib/prohibited-terms";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listProhibitedTerms(context) });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_rejected"); }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin"]);
    const input = parseProhibitedTermInput(await readBoundedJson(request));
    if (!input) return Response.json({ error: "invalid_prohibited_term" }, { status: 400 });
    return Response.json({ data: await createProhibitedTerm(context, input) }, { status: 201 });
  } catch (error) { return prohibitedTermErrorResponse(error, "prohibited_term_rejected"); }
}
