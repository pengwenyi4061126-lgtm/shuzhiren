import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { createMediaUploadGrant } from "@/lib/media-evidence";
import type { AssetKind } from "@/lib/assets";
import { isSha256Digest } from "@/lib/governance-input";

export const dynamic = "force-dynamic";

const kinds = new Set<AssetKind>(["portrait", "portrait_photo", "voice", "product_clip", "music", "overlay_background"]);

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!body || typeof body !== "object") return Response.json({ error: "invalid_media_upload" }, { status: 400 });
    const input = body as Record<string, unknown>;
    if (typeof input.kind !== "string" || !kinds.has(input.kind as AssetKind)
      || !isSha256Digest(input.checksum) || typeof input.checksumBase64 !== "string"
      || !isMatchingDigest(input.checksum, input.checksumBase64)
      || typeof input.contentType !== "string" || input.contentType.length > 100
      || typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 100 * 1024 * 1024) {
      return Response.json({ error: "invalid_media_upload" }, { status: 400 });
    }
    const grant = await createMediaUploadGrant(context, { kind: input.kind as AssetKind, checksum: input.checksum, checksumBase64: input.checksumBase64, contentType: input.contentType, bytes: input.bytes });
    return Response.json({ data: grant }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "media_upload_grant_failed" }, { status: error.status });
    throw error;
  }
}

function isMatchingDigest(hexDigest: string, base64Digest: string) {
  try {
    const bytes = Uint8Array.from(hexDigest.slice("sha256:".length).match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary) === base64Digest;
  } catch { return false; }
}
