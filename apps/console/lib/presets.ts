import { requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";
import { recordAuditEvent, recordAuditEventInTransaction, type AuditEventInput } from "@/lib/audit";
import { createMediaAsset, type AssetKind, type CreateMediaAssetInput, type MediaAsset } from "@/lib/assets";
import { verifyMediaAssetContent } from "@/lib/media-evidence";

// Platform-wide default avatars and voices (migration 082, table runtime_presets). A preset names a runtime
// reference and its license facts only; it ships no material. Adopting one creates a pending media asset in the
// tenant's own library from material the tenant uploaded to its object storage (objectKey + checksum), with the
// same content verification as POST /api/v1/assets. Approval stays POST /api/v1/assets/{id}/approve.
export type RuntimePresetKind = "avatar" | "voice";
export type RuntimePresetModelKind = "sft" | "zero_shot" | "any";
export type CommercialUseStatus = "verified" | "unverified";
export type RuntimePreset = {
  code: string;
  kind: RuntimePresetKind;
  displayName: string;
  gender?: "female" | "male" | "neutral";
  voiceStyle?: string;
  compatibleModelKind: RuntimePresetModelKind;
  runtimeRef: string;
  sftSpeakerId?: string;
  materialRequirements: string;
  licenseName: string;
  licenseSourceUrl?: string;
  commercialUseStatus: CommercialUseStatus;
};
export type AdoptPresetInput = Pick<CreateMediaAssetInput, "objectKey" | "checksum"> & { expiresAt?: string };

type PresetRow = {
  preset_code: string;
  kind: RuntimePresetKind;
  display_name: string;
  gender: RuntimePreset["gender"] | null;
  voice_style: string | null;
  compatible_model_kind: RuntimePresetModelKind;
  runtime_ref: string;
  sft_speaker_id: string | null;
  material_requirements: string;
  license_name: string;
  license_source_url: string | null;
  commercial_use_status: CommercialUseStatus;
};
type AdoptedAssetRow = { id: string; tenant_id: string; kind: AssetKind; name: string; approval_status: MediaAsset["approval"]; expires_at: string | null; rights_scope: string; source_ref: string; object_key: string; checksum: string; runtime_voice_id: string | null; verified_object_version: string | null; verified_bytes: string | number | null; verified_content_type: string | null; verification_evidence_ref: string | null; verified_at: Date | string | null };

export const presetCodePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const presetColumns = "preset_code, kind, display_name, gender, voice_style, compatible_model_kind, runtime_ref, sft_speaker_id, material_requirements, license_name, license_source_url, commercial_use_status";

// Demo mode (no database) mirrors the seed rows of 082_runtime_presets.sql; scripts/test-runtime-presets.mjs
// keeps the two in step.
const demoPresetRows: RuntimePreset[] = [
  { code: "preset-zh-female", kind: "voice", displayName: "默认女声（中文）", gender: "female", voiceStyle: "普通话 · 标准女声", compatibleModelKind: "any", runtimeRef: "preset-zh-female", sftSpeakerId: "中文女", materialRequirements: "sft：加载自带“中文女”说话人的 CosyVoice-300M-SFT 权重，Gateway 按 COSYVOICE_SFT_SPEAKER_MAP 映射；zero_shot（模板默认 Fun-CosyVoice3）：运营方在声音库放入已授权的 preset-zh-female/prompt.wav 与含 <|endofprompt|> 的 prompt.txt。两种模式都需把同一份已授权音频上传到本租户对象存储，供内容校验与审批。", licenseName: "CosyVoice-300M-SFT 权重与内置说话人许可（未核实）", licenseSourceUrl: "https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT", commercialUseStatus: "unverified" },
  { code: "preset-zh-male", kind: "voice", displayName: "默认男声（中文）", gender: "male", voiceStyle: "普通话 · 标准男声", compatibleModelKind: "any", runtimeRef: "preset-zh-male", sftSpeakerId: "中文男", materialRequirements: "sft：加载自带“中文男”说话人的 CosyVoice-300M-SFT 权重，Gateway 按 COSYVOICE_SFT_SPEAKER_MAP 映射；zero_shot（模板默认 Fun-CosyVoice3）：运营方在声音库放入已授权的 preset-zh-male/prompt.wav 与含 <|endofprompt|> 的 prompt.txt。两种模式都需把同一份已授权音频上传到本租户对象存储，供内容校验与审批。", licenseName: "CosyVoice-300M-SFT 权重与内置说话人许可（未核实）", licenseSourceUrl: "https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT", commercialUseStatus: "unverified" },
  { code: "preset-avatar-default", kind: "avatar", displayName: "默认数字人形象（运营方提供）", compatibleModelKind: "any", runtimeRef: "preset-avatar-default", materialRequirements: "运营方在 AVATAR_VOLUME_PATH/preset-avatar-default 放入已取得肖像授权的 LiveTalking Avatar 数据，并设置 LIVETALKING_AVATAR_ID=preset-avatar-default；同时把形象视频上传到本租户对象存储，供内容校验与审批。仓库不附带任何形象素材。", licenseName: "运营方自备形象素材许可（未核实）", commercialUseStatus: "unverified" }
];
export const demoRuntimePresets: readonly RuntimePreset[] = Object.freeze(demoPresetRows.map((preset) => Object.freeze(preset)));

export async function listPresets(context: RequestContext): Promise<RuntimePreset[]> {
  if (!databasePool()) return [...demoRuntimePresets];
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PresetRow>(`select ${presetColumns} from runtime_presets where enabled order by kind desc, preset_code`);
    return result.rows.map(persistentPreset);
  }, { readOnly: true });
}

async function findEnabledPreset(context: RequestContext, presetCode: string) {
  if (!presetCodePattern.test(presetCode)) return null;
  if (!databasePool()) return demoRuntimePresets.find((preset) => preset.code === presetCode) ?? null;
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<PresetRow>(`select ${presetColumns} from runtime_presets where enabled and preset_code = $1`, [presetCode]);
    return result.rows[0] ? persistentPreset(result.rows[0]) : null;
  }, { readOnly: true });
}

/** The pending media asset that adopting `preset` with the tenant's uploaded material creates. */
export function presetAssetInput(preset: RuntimePreset, input: AdoptPresetInput): CreateMediaAssetInput {
  const status = commercialUseLabel(preset.commercialUseStatus);
  const runtime = preset.kind === "voice" ? `runtime_voice_id=${preset.runtimeRef}${preset.sftSpeakerId ? `（sft 说话人 ${preset.sftSpeakerId}）` : ""}` : `LiveTalking avatar_id=${preset.runtimeRef}`;
  return {
    kind: preset.kind === "voice" ? "voice" : "portrait",
    name: `默认库：${preset.displayName}`,
    rightsScope: `来源：平台默认预设 ${preset.code}；许可：${preset.licenseName}；商用授权${status}。上线前须由运营方取得并留存素材授权。`,
    source: [`preset:${preset.code}`, runtime, preset.licenseSourceUrl].filter(Boolean).join(" · "),
    objectKey: input.objectKey,
    checksum: input.checksum,
    runtimeVoiceId: preset.kind === "voice" ? preset.runtimeRef : undefined,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
  };
}

export function commercialUseLabel(status: CommercialUseStatus) {
  return status === "verified" ? "已核实" : "未核实";
}

export async function adoptPreset(context: RequestContext, presetCode: string, input: AdoptPresetInput): Promise<{ asset: MediaAsset; preset: RuntimePreset }> {
  requireTenantWideAccess(context);
  const preset = await findEnabledPreset(context, presetCode);
  if (!preset) throw new Response("Preset not found or disabled", { status: 404, statusText: "preset_not_found" });
  const assetInput = presetAssetInput(preset, input);
  if (!databasePool()) {
    const asset = await createMediaAsset(context, assetInput);
    await recordAuditEvent(context, presetAdoptedAudit(asset, preset));
    return { asset, preset };
  }
  // The same content verification as createMediaAsset: the tenant's object must exist with this checksum.
  const verification = await verifyMediaAssetContent(context, assetInput);
  // The asset, media_asset.created and runtime_preset.adopted commit together.
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<AdoptedAssetRow>(
      `insert into media_assets (tenant_id, kind, name, object_key, checksum, rights_scope, source_ref, expires_at, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at) values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14::timestamptz) returning id, tenant_id, kind, name, approval_status, expires_at, rights_scope, source_ref, object_key, checksum, runtime_voice_id, verified_object_version, verified_bytes, verified_content_type, verification_evidence_ref, verified_at`,
      [context.tenantId, assetInput.kind, assetInput.name, assetInput.objectKey, assetInput.checksum, assetInput.rightsScope, assetInput.source, assetInput.expiresAt ?? null, assetInput.runtimeVoiceId ?? null, verification.objectVersion, verification.bytes, verification.contentType, verification.evidenceRef, verification.verifiedAt]
    );
    const asset = adoptedAsset(result.rows[0]);
    await recordAuditEventInTransaction(client, context, { type: "media_asset.created", resource: "media_asset", resourceId: asset.id, detail: { kind: asset.kind, objectKey: asset.objectKey, objectVersion: verification.objectVersion, checksum: asset.checksum, verificationEvidenceRef: verification.evidenceRef, presetCode: preset.code } });
    await recordAuditEventInTransaction(client, context, presetAdoptedAudit(asset, preset));
    return { asset, preset };
  });
}

function presetAdoptedAudit(asset: MediaAsset, preset: RuntimePreset): AuditEventInput {
  return { type: "runtime_preset.adopted", resource: "media_asset", resourceId: asset.id, detail: { presetCode: preset.code, presetKind: preset.kind, runtimeRef: preset.runtimeRef, licenseName: preset.licenseName, commercialUseStatus: preset.commercialUseStatus, approval: asset.approval } };
}

function persistentPreset(row: PresetRow): RuntimePreset {
  return {
    code: row.preset_code,
    kind: row.kind,
    displayName: row.display_name,
    gender: row.gender ?? undefined,
    voiceStyle: row.voice_style ?? undefined,
    compatibleModelKind: row.compatible_model_kind,
    runtimeRef: row.runtime_ref,
    sftSpeakerId: row.sft_speaker_id ?? undefined,
    materialRequirements: row.material_requirements,
    licenseName: row.license_name,
    licenseSourceUrl: row.license_source_url ?? undefined,
    commercialUseStatus: row.commercial_use_status
  };
}

function adoptedAsset(row: AdoptedAssetRow): MediaAsset {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    name: row.name,
    approval: row.approval_status,
    expiresAt: row.expires_at ?? undefined,
    rightsScope: row.rights_scope,
    source: row.source_ref,
    objectKey: row.object_key,
    checksum: row.checksum,
    contentVerification: row.verified_object_version && row.verified_content_type && row.verification_evidence_ref && row.verified_at && row.verified_bytes !== null
      ? { objectVersion: row.verified_object_version, bytes: Number(row.verified_bytes), contentType: row.verified_content_type, evidenceRef: row.verification_evidence_ref, verifiedAt: new Date(row.verified_at).toISOString() }
      : undefined,
    runtimeVoiceId: row.runtime_voice_id ?? undefined
  };
}
