import { readBoundedJson } from "@/lib/bounded-json";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { isSafeObjectKey, isSha256Digest } from "@/lib/governance-input";
import { adoptPreset, type AdoptPresetInput } from "@/lib/presets";

export const dynamic = "force-dynamic";

// Adopts a platform preset into the tenant's media library as a pending asset. The body names the material the
// tenant uploaded (objectKey + sha256 checksum); it is content-verified like POST /api/v1/assets and still needs
// POST /api/v1/assets/{assetId}/approve before any show can use it.
export async function POST(request: Request, context: RouteContext<"/api/v1/presets/[presetCode]/adopt">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const { presetCode } = await context.params;
    let body: unknown;
    try { body = await readBoundedJson(request); }
    catch (error) { if (error instanceof Response) return Response.json({ error: error.statusText || "request_too_large" }, { status: error.status }); throw error; }
    if (!isAdoptInput(body)) return Response.json({ error: "invalid_preset_adoption" }, { status: 400 });
    // adoptPreset writes media_asset.created and runtime_preset.adopted in the asset's transaction.
    const outcome = await adoptPreset(actor, presetCode, { objectKey: body.objectKey, checksum: body.checksum, expiresAt: body.expiresAt });
    return Response.json({ data: outcome.asset, meta: { presetCode: outcome.preset.code, commercialUseStatus: outcome.preset.commercialUseStatus } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "preset_adoption_rejected" }, { status: error.status });
    throw error;
  }
}

function isAdoptInput(value: unknown): value is AdoptPresetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return isSafeObjectKey(input.objectKey) && isSha256Digest(input.checksum)
    && (input.expiresAt === undefined || (typeof input.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt) && !Number.isNaN(Date.parse(input.expiresAt))));
}
