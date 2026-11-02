import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createModelRelease, listModelReleases, type CreateModelReleaseInput, type ReleaseComponent } from "@/lib/releases";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { const context = await requestContextFrom(request); return Response.json({ data: await listModelReleases(context) }); }
export async function POST(request: Request) {
  const context = await requestContextFrom(request); requireRole(context, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isReleaseInput(body)) return Response.json({ error: "invalid_model_release" }, { status: 400 });
  try { const release = await createModelRelease(context, body); await recordAuditEvent(context, { type: "model_release.created", resource: "model_release", resourceId: release.id, detail: { component: release.component, version: release.version, artifactHash: release.artifactHash } }); return Response.json({ data: release }, { status: 201 }); } catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText }, { status: error.status }); throw error; }
}
function isReleaseInput(value: unknown): value is CreateModelReleaseInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>; const components = new Set<ReleaseComponent>(["runtime", "avatar", "lip_sync", "voice"]);
  return typeof input.component === "string" && components.has(input.component as ReleaseComponent) && ["name", "version", "sourceCommit", "imageDigest", "artifactHash", "driverVersion", "license", "rightsScope"].every((key) => typeof input[key] === "string" && input[key].trim().length > 0) && (input.notes === undefined || typeof input.notes === "string");
}
