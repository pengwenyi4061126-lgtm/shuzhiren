import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { evaluatePolicy } from "@/lib/policy-engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator", "reviewer"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isPolicyInput(body)) return Response.json({ error: "invalid_input" }, { status: 400 });
  return Response.json({ data: evaluatePolicy(body.question, body.evidenceIds) });
}

function isPolicyInput(value: unknown): value is { question: string; evidenceIds: string[] } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.question === "string" && input.question.length > 0 && Array.isArray(input.evidenceIds) && input.evidenceIds.every((item) => typeof item === "string");
}
