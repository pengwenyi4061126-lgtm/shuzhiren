import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Demo-only, repository-owned sample package.  It is deliberately separate
 * from a production media upload: production assets must still go through the
 * evidence verifier and object storage.
 */
export const verifiedStudioSamplePhoto = {
  assetId: "asset_verified_sample_portrait_photo",
  objectKey: "demo-samples/digital-host/host-portrait.png",
  checksum: "sha256:52681702eada8ad42cedf1dc283066784194b5f91e9c5153f335bceb3914c18c",
  fileName: "host-portrait.png",
  bytes: 2_107_797,
  contentType: "image/png",
  objectVersion: "sample-4090-20261111",
  evidenceRef: "evidence:sample-assets/digital-host/host-portrait.png"
} as const;

export const verifiedStudioSampleVoice = {
  assetId: "asset_verified_sample_voice",
  objectKey: "demo-samples/digital-host/host-voice.wav",
  // This is the frozen voice-library checksum accepted by the 4090 Runtime,
  // not the checksum of one rendered WAV output below.
  runtimeChecksum: "sha256:c7b31d6dbe7cc6a716dded00550db5b50940bf209e424e4ad207b12e657c8ff6",
  runtimeVoiceId: "p0-test-voice",
  fileName: "host-voice.wav",
  fileChecksum: "sha256:3ae050544186d4846ae2b43f46ca795d19fcd378f164faa10b42875ec972614e",
  bytes: 2_085_164,
  contentType: "audio/wav",
  objectVersion: "sample-4090-20261111",
  evidenceRef: "evidence:sample-assets/digital-host/host-voice.wav"
} as const;

export const verifiedStudioSample = {
  projectName: "4090 已验证样片 · 氨基酸洁面慕斯",
  goal: "用一份已验收素材体验录播制作，并查看对应的 4090 直播质量证据",
  audience: "第一次使用数字人直播的店主",
  outputMode: "both" as const,
  script: "你好，欢迎来到数字人直播样片。今天介绍氨基酸洁面慕斯，价格九十九元。它采用氨基酸表活，泡沫细腻，适合日常清洁。按压泵头方便取用，商品资料还记录赠旅行装三件套，并支持四十八小时内发货。以上内容来自已审核商品资料，实际购买请以商品详情页为准。"
} as const;

export const verifiedStudioSampleAssetIds = [
  verifiedStudioSamplePhoto.assetId,
  verifiedStudioSampleVoice.assetId,
  "asset_clip_a102",
  "asset_bgm_demo"
] as const;

type SampleMediaKind = "photo" | "voice";

export function isVerifiedStudioSamplePhoto(asset: { id: string; objectKey: string; checksum: string }) {
  return asset.id === verifiedStudioSamplePhoto.assetId
    && asset.objectKey === verifiedStudioSamplePhoto.objectKey
    && asset.checksum.toLowerCase() === verifiedStudioSamplePhoto.checksum;
}

export function isVerifiedStudioSampleVoice(asset: { id: string; runtimeVoiceId?: string; checksum: string }) {
  return asset.id === verifiedStudioSampleVoice.assetId
    && asset.runtimeVoiceId === verifiedStudioSampleVoice.runtimeVoiceId
    && asset.checksum.toLowerCase() === verifiedStudioSampleVoice.runtimeChecksum;
}

export function isVerifiedStudioSampleScript(script: string) {
  return script.trim() === verifiedStudioSample.script;
}

export async function readVerifiedStudioSampleMedia(kind: SampleMediaKind) {
  const expected = kind === "photo"
    ? { fileName: verifiedStudioSamplePhoto.fileName, bytes: verifiedStudioSamplePhoto.bytes, checksum: verifiedStudioSamplePhoto.checksum }
    : { fileName: verifiedStudioSampleVoice.fileName, bytes: verifiedStudioSampleVoice.bytes, checksum: verifiedStudioSampleVoice.fileChecksum };
  const file = await resolveSampleFile(expected.fileName);
  const data = await readFile(file);
  const checksum = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  if (data.byteLength !== expected.bytes || checksum !== expected.checksum) {
    throw new Error("verified_studio_sample_integrity_failed");
  }
  return data;
}

async function resolveSampleFile(fileName: string) {
  const roots = [
    process.env.SHUZIREN_SAMPLE_ASSETS_ROOT,
    path.resolve(process.cwd(), "sample-assets", "digital-host"),
    path.resolve(process.cwd(), "..", "..", "sample-assets", "digital-host")
  ].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    const candidate = path.resolve(normalizedRoot, fileName);
    if (path.dirname(candidate) !== normalizedRoot) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported workspace layout.
    }
  }
  throw new Error("verified_studio_sample_file_missing");
}
