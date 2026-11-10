import { readBoundedJson } from "@/lib/bounded-json";
import { verifyAvatarBuildPublishInput } from "@/lib/avatar-build-jobs";
import { tokenMatches } from "@/lib/runtime-service-auth";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const expected = process.env.RUNTIME_SHARED_TOKEN ?? "";
  if (!expected || !tokenMatches(request.headers.get("authorization"), expected)) {
    return Response.json({ error: "runtime_service_unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  let body: unknown;
  try { body = await readBoundedJson(request, 4 * 1024); }
  catch (error) { if (error instanceof Response) return Response.json({ error: "avatar_publish_input_invalid" }, { status: error.status }); throw error; }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).join(",") !== "tenantId"
    || typeof (body as { tenantId?: unknown }).tenantId !== "string") {
    return Response.json({ error: "avatar_publish_input_invalid" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const { jobId } = await params;
    const candidate = await verifyAvatarBuildPublishInput((body as { tenantId: string }).tenantId, jobId);
    if (!candidate) return Response.json({ error: "avatar_source_stale" }, { status: 409, headers: { "cache-control": "no-store" } });
    return Response.json({ data: candidate }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "avatar_publish_check_failed" }, { status: error.status, headers: { "cache-control": "no-store" } });
    throw error;
  }
}
