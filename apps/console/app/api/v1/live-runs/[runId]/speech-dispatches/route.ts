import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { enqueueGroundedSpeech } from "@/lib/control-plane/store";
import { isSafeSpeechCommandId } from "@/lib/speech-protocol";
import { isControlledPolicyQuestion } from "@/lib/policy-engine";
import { readBoundedJson } from "@/lib/bounded-json";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/live-runs/[runId]/speech-dispatches">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    if (!isSpeechInput(body)) return Response.json({ error: "invalid_question" }, { status: 400 });
    const { runId } = await context.params;
    const result = await enqueueGroundedSpeech(actor, runId, body.question.trim(), body.idempotencyKey);
    return Response.json({ data: result }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "speech_dispatch_rejected" }, { status: error.status });
    return Response.json({ error: error instanceof Error ? error.message : "speech_dispatch_unavailable" }, { status: 503 });
  }
}

function isSpeechInput(value: unknown): value is { question: string; idempotencyKey: string } {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).question === "string"
    && typeof (value as Record<string, unknown>).idempotencyKey === "string"
    && isControlledPolicyQuestion((value as Record<string, string>).question)
    && isSafeSpeechCommandId((value as Record<string, string>).idempotencyKey);
}
