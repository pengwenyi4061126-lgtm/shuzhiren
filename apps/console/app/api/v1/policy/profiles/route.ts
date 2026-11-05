import { recordAuditEvent } from "@/lib/audit";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createPolicyProfile, isPolicyRule, listPolicyProfiles, type CreatePolicyProfileInput } from "@/lib/policy-profiles";
import { isControlledEvidenceRef } from "@/lib/governance-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator", "reviewer", "analyst"]);
    return Response.json({ data: await listPolicyProfiles(context) });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "policy_profile_rejected" }, { status: error.status });
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    const body = await readBoundedJson(request);
    if (!isInput(body)) return Response.json({ error: "invalid_policy_profile" }, { status: 400 });
    const profile = await createPolicyProfile(context, body);
    await recordAuditEvent(context, { type: "policy_profile.created", resource: "policy_profile", resourceId: profile.id, detail: { name: profile.name, version: profile.version, ruleCount: profile.rules.length } });
    return Response.json({ data: profile }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "policy_profile_rejected" }, { status: error.status });
    throw error;
  }
}

function isInput(value: unknown): value is CreatePolicyProfileInput {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return ["name", "version", "validationSummary"].every((key) => typeof body[key] === "string" && body[key].trim().length > 0)
    && typeof body.evidenceRef === "string" && isControlledEvidenceRef(body.evidenceRef.trim())
    && Array.isArray(body.rules) && body.rules.length <= 30 && body.rules.every(isPolicyRule);
}
