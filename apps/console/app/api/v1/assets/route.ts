import { recordAuditEvent } from "@/lib/audit";
import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createMediaAsset, isRuntimeVoiceId, listAssets, type CreateMediaAssetInput } from "@/lib/assets";
import { isSafeObjectKey, isSha256Digest } from "@/lib/governance-input";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await requestContextFrom(request);
  requireRole(actor, ["admin", "operator", "reviewer", "analyst"]);
  return Response.json({ data: await listAssets(actor) });
}

export async function POST(request: Request) {
  const context = await requestContextFrom(request);
  requireRole(context, ["admin", "operator"]);
  let body: unknown;
  try { body = await readBoundedJson(request); }
  catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
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
    && ["name", "rightsScope", "source"].every((key) => typeof input[key] === "string" && input[key].trim().length > 0)
    && isSafeObjectKey(input.objectKey) && isSha256Digest(input.checksum)
    && (input.kind !== "voice" || isRuntimeVoiceId(input.runtimeVoiceId))
    && (input.kind === "voice" || input.runtimeVoiceId === undefined)
    && (input.expiresAt === undefined || (typeof input.expiresAt === "string" && !Number.isNaN(Date.parse(input.expiresAt))));
}
