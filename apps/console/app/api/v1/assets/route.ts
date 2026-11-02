import { recordAuditEvent } from "@/lib/audit";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createMediaAsset, listAssets, type CreateMediaAssetInput } from "@/lib/assets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json({ data: await listAssets(await requestContextFrom(request)) });
}

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator"]);
  const body: unknown = await request.json().catch(() => null);
  if (!isAssetInput(body)) return Response.json({ error: "invalid_media_asset" }, { status: 400 });
  const asset = await createMediaAsset(context, body);
  await recordAuditEvent(context, { type: "media_asset.created", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, objectKey: asset.objectKey } });
  return Response.json({ data: asset }, { status: 201 });
}

function isAssetInput(value: unknown): value is CreateMediaAssetInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const kinds = new Set(["portrait", "voice", "product_clip", "music"]);
  return typeof input.kind === "string" && kinds.has(input.kind)
    && ["name", "rightsScope", "source", "objectKey", "checksum"].every((key) => typeof input[key] === "string" && input[key].length > 0)
    && (input.expiresAt === undefined || (typeof input.expiresAt === "string" && !Number.isNaN(Date.parse(input.expiresAt))));
}
