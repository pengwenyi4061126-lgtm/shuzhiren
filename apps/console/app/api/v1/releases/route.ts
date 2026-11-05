import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createModelRelease, listModelReleases, type CreateModelReleaseInput, type ReleaseComponent } from "@/lib/releases";
import { isControlledEvidenceRef, isGitCommit, isSha256Digest } from "@/lib/governance-input";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const context = await requestContextFrom(request); requireRole(context, ["admin", "operator", "reviewer", "analyst"]); return Response.json({ data: await listModelReleases(context) }); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "model_release_rejected" }, { status: error.status }); throw error; }
}
export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request); requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isReleaseInput(body)) return Response.json({ error: "invalid_model_release" }, { status: 400 });
    // createModelRelease writes model_release.created in the release's transaction.
    const release = await createModelRelease(context, body); return Response.json({ data: release }, { status: 201 });
  } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "model_release_rejected" }, { status: error.status }); throw error; }
}
function isReleaseInput(value: unknown): value is CreateModelReleaseInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>; const components = new Set<ReleaseComponent>(["runtime", "avatar", "lip_sync", "voice"]);
  return typeof input.component === "string" && components.has(input.component as ReleaseComponent)
    && ["name", "version", "driverVersion", "license", "rightsScope", "validationSummary"].every((key) => typeof input[key] === "string" && input[key].trim().length > 0)
    && typeof input.evidenceRef === "string" && isControlledEvidenceRef(input.evidenceRef.trim())
    && isGitCommit(input.sourceCommit) && isSha256Digest(input.imageDigest) && isSha256Digest(input.artifactHash)
    && (input.notes === undefined || typeof input.notes === "string");
}
