import { readBoundedJson } from "@/lib/bounded-json";
import { isRuntimeVoiceId, isVoiceChecksum, listAssets } from "@/lib/assets";
import { assertCreationProjectScriptReviewed, listCreationProjects } from "@/lib/creation-projects";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { controlPlaneConfig } from "@/lib/control-plane/config";
import { RuntimeGatewayError, synthesizeRuntimeSpeechPreview } from "@/lib/runtime-gateway";
import { isAssetCurrentlyUsable } from "@/lib/shared/asset-eligibility.mjs";
import { isVerifiedStudioSampleScript, isVerifiedStudioSampleVoice, readVerifiedStudioSampleMedia } from "@/lib/verified-studio-sample";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/v1/studio/projects/[projectId]/speech-preview">) {
  try {
    const actor = await requestContextFrom(request);
    requireRole(actor, ["admin", "operator"]);
    const body = await readBoundedJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).voiceAssetId !== "string") {
      return Response.json({ error: "invalid_speech_preview" }, { status: 400 });
    }
    const { projectId } = await context.params;
    const project = (await listCreationProjects(actor)).find((item) => item.id === projectId);
    if (!project) return Response.json({ error: "creation_project_not_found" }, { status: 404 });
    await assertCreationProjectScriptReviewed(actor, project.id, project.productVersionId);
    const voiceAssetId = (body as { voiceAssetId: string }).voiceAssetId;
    if (!project.assetIds.includes(voiceAssetId)) return Response.json({ error: "voice_asset_not_attached" }, { status: 409 });
    const asset = (await listAssets(actor)).find((item) => item.id === voiceAssetId);
    if (!asset || asset.kind !== "voice" || !isAssetCurrentlyUsable(asset)
      || !isRuntimeVoiceId(asset.runtimeVoiceId) || !isVoiceChecksum(asset.checksum) || !asset.contentVerification) {
      return Response.json({ error: "approved_runtime_voice_required" }, { status: 409 });
    }
    if (controlPlaneConfig().demoMode && isVerifiedStudioSampleVoice(asset) && isVerifiedStudioSampleScript(project.script)) {
      const audio = await readVerifiedStudioSampleMedia("voice");
      return new Response(audio, { headers: {
        "content-type": "audio/wav",
        "cache-control": "no-store",
        "content-disposition": "inline; filename=verified-4090-speech-preview.wav",
        "x-shuziren-sample-media": "verified-4090"
      } });
    }
    const audio = await synthesizeRuntimeSpeechPreview(project.script, asset.runtimeVoiceId, asset.checksum);
    return new Response(audio, { headers: { "content-type": "audio/wav", "cache-control": "no-store", "content-disposition": "inline; filename=speech-preview.wav" } });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "speech_preview_rejected" }, { status: error.status });
    if (error instanceof RuntimeGatewayError) return Response.json({ error: error.code ?? "speech_preview_unavailable" }, { status: error.status });
    return Response.json({ error: "speech_preview_unavailable" }, { status: 503 });
  }
}
