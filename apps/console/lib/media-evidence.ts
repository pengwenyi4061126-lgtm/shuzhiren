import { controlPlaneConfig } from "@/lib/control-plane/config";
import { isSafeObjectKey, isSha256Digest } from "@/lib/governance-input";
import type { AssetKind, CreateMediaAssetInput } from "@/lib/assets";

export type MediaContentVerification = {
  objectVersion: string;
  bytes: number;
  contentType: string;
  evidenceRef: string;
  verifiedAt: string;
};

type VerifierConfig = { url?: string; token?: string; demoMode: boolean; timeoutMs: number };

export type MediaUploadGrant = { objectKey: string; uploadUrl?: string; headers?: Record<string, string>; expiresAt: string; demoMode: boolean };
export type MediaDownloadGrant = { downloadUrl: string; expiresAt: string };

export async function createMediaUploadGrant(context: { tenantId: string }, input: { kind: AssetKind; checksum: string; checksumBase64: string; contentType: string; bytes: number }): Promise<MediaUploadGrant> {
  if (!isSha256Digest(input.checksum) || !/^[A-Za-z0-9+/]{43}=$/.test(input.checksumBase64)
    || !contentTypeMatches(input.kind, input.contentType) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 100 * 1024 * 1024) {
    throw new Response("Media upload input is invalid", { status: 400 });
  }
  const config = verifierConfig();
  if (config.demoMode) return { objectKey: `demo-uploads/${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), demoMode: true };
  const response = await fetch(`${config.url}/v1/media-evidence/upload-grant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ tenantId: context.tenantId, kind: input.kind, checksum: input.checksum, checksumBase64: input.checksumBase64, contentType: normalizedContentType(input.contentType), bytes: input.bytes }),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Response("Media upload authorization failed", { status: 502 });
  return validateUploadGrant(await response.json(), input);
}

export async function createMediaDownloadGrant(context: { tenantId: string }, input: { objectKey: string; objectVersion: string; checksum: string; fileName: string }): Promise<MediaDownloadGrant> {
  if (!isSafeObjectKey(input.objectKey) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.objectVersion) || !isSha256Digest(input.checksum)
    || input.fileName.length < 1 || input.fileName.length > 160 || /[\\/:*?"<>|\u0000-\u001f]/.test(input.fileName)) {
    throw new Response("Media download input is invalid", { status: 400 });
  }
  const config = verifierConfig();
  if (config.demoMode) throw new Response("Server-side media download is unavailable in demo mode", { status: 503 });
  const response = await fetch(`${config.url}/v1/media-evidence/download-grant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ tenantId: context.tenantId, objectKey: input.objectKey, objectVersion: input.objectVersion, expectedChecksum: input.checksum, fileName: input.fileName }),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Response("Media download authorization failed", { status: 502 });
  return validateDownloadGrant(await response.json());
}

export async function verifyMediaAssetContent(context: { tenantId: string }, input: Pick<CreateMediaAssetInput, "kind" | "objectKey" | "checksum">): Promise<MediaContentVerification> {
  const config = verifierConfig();
  if (config.demoMode) return { objectVersion: "demo", bytes: 1, contentType: expectedContentType(input.kind), evidenceRef: "demo://media-evidence", verifiedAt: new Date().toISOString() };
  const response = await fetch(`${config.url}/v1/media-evidence/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ tenantId: context.tenantId, kind: input.kind, objectKey: input.objectKey, expectedChecksum: input.checksum }),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Response("Media evidence verification failed", { status: 502 });
  return validateVerification(await response.json(), input);
}

function verifierConfig(): VerifierConfig {
  const config = controlPlaneConfig();
  const url = process.env.MEDIA_EVIDENCE_VERIFIER_URL;
  const token = process.env.MEDIA_EVIDENCE_VERIFIER_TOKEN;
  const timeoutMs = boundedTimeout();
  if (config.demoMode) return { demoMode: true, timeoutMs };
  if (!url || !token) throw new Response("Media evidence verifier is not configured", { status: 503 });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Response("Media evidence verifier configuration is invalid", { status: 503 }); }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !loopbackHttp) || token.length < 32 || /\s/.test(token)) throw new Response("Media evidence verifier configuration is invalid", { status: 503 });
  return { url: url.replace(/\/$/, ""), token, demoMode: false, timeoutMs };
}

function boundedTimeout() {
  const value = Number.parseInt(process.env.MEDIA_EVIDENCE_VERIFIER_TIMEOUT_MS ?? "5000", 10);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Response("Media evidence verifier configuration is invalid", { status: 503 });
  return value;
}

function validateVerification(value: unknown, input: Pick<CreateMediaAssetInput, "kind" | "objectKey" | "checksum">): MediaContentVerification {
  if (!value || typeof value !== "object") throw new Response("Media evidence verifier response is invalid", { status: 502 });
  const proof = value as Record<string, unknown>;
  if (proof.objectKey !== input.objectKey || proof.checksum !== input.checksum || !isSafeObjectKey(proof.objectKey) || !isSha256Digest(proof.checksum)
    || typeof proof.objectVersion !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(proof.objectVersion)
    || typeof proof.bytes !== "number" || !Number.isSafeInteger(proof.bytes) || proof.bytes < 1
    || typeof proof.contentType !== "string" || !contentTypeMatches(input.kind, proof.contentType)
    || typeof proof.evidenceRef !== "string" || !isOpaqueEvidenceRef(proof.evidenceRef)
    || typeof proof.verifiedAt !== "string") throw new Response("Media evidence verifier response is invalid", { status: 502 });
  const verifiedAt = new Date(proof.verifiedAt);
  const age = Date.now() - verifiedAt.getTime();
  if (Number.isNaN(verifiedAt.getTime()) || age < -60_000 || age > 10 * 60_000) throw new Response("Media evidence verifier response is invalid", { status: 502 });
  return { objectVersion: proof.objectVersion, bytes: proof.bytes, contentType: normalizedContentType(proof.contentType), evidenceRef: proof.evidenceRef, verifiedAt: verifiedAt.toISOString() };
}

function validateUploadGrant(value: unknown, input: { checksumBase64: string; contentType: string }): MediaUploadGrant {
  if (!value || typeof value !== "object") throw new Response("Media upload authorization response is invalid", { status: 502 });
  const grant = value as Record<string, unknown>;
  let uploadUrl: URL;
  try { uploadUrl = new URL(String(grant.uploadUrl)); } catch { throw new Response("Media upload authorization response is invalid", { status: 502 }); }
  const loopbackHttp = uploadUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(uploadUrl.hostname);
  const headers = grant.headers;
  const expiresAt = typeof grant.expiresAt === "string" ? new Date(grant.expiresAt) : new Date(Number.NaN);
  if (!isSafeObjectKey(grant.objectKey) || uploadUrl.username || uploadUrl.password || uploadUrl.hash
    || (uploadUrl.protocol !== "https:" && !loopbackHttp) || !headers || typeof headers !== "object"
    || Object.keys(headers).some((key) => !["content-type", "x-amz-checksum-sha256"].includes(key.toLowerCase()))
    || (headers as Record<string, unknown>)["content-type"] !== normalizedContentType(input.contentType)
    || (headers as Record<string, unknown>)["x-amz-checksum-sha256"] !== input.checksumBase64
    || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 15 * 60_000) {
    throw new Response("Media upload authorization response is invalid", { status: 502 });
  }
  return { objectKey: String(grant.objectKey), uploadUrl: uploadUrl.toString(), headers: headers as Record<string, string>, expiresAt: expiresAt.toISOString(), demoMode: false };
}

function validateDownloadGrant(value: unknown): MediaDownloadGrant {
  if (!value || typeof value !== "object") throw new Response("Media download authorization response is invalid", { status: 502 });
  const grant = value as Record<string, unknown>;
  let downloadUrl: URL;
  try { downloadUrl = new URL(String(grant.downloadUrl)); } catch { throw new Response("Media download authorization response is invalid", { status: 502 }); }
  const expiresAt = typeof grant.expiresAt === "string" ? new Date(grant.expiresAt) : new Date(Number.NaN);
  const loopbackHttp = downloadUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(downloadUrl.hostname);
  if ((downloadUrl.protocol !== "https:" && !loopbackHttp) || downloadUrl.username || downloadUrl.password || downloadUrl.hash
    || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 5 * 60_000) {
    throw new Response("Media download authorization response is invalid", { status: 502 });
  }
  return { downloadUrl: downloadUrl.toString(), expiresAt: expiresAt.toISOString() };
}

function contentTypeMatches(kind: AssetKind, value: string) {
  const type = normalizedContentType(value);
  if (kind === "overlay_background") return type === "image/png" || type === "image/jpeg";
  if (kind === "portrait_photo") return type === "image/png" || type === "image/jpeg";
  return (kind === "portrait" || kind === "product_clip") ? type.startsWith("video/") : type.startsWith("audio/");
}

function normalizedContentType(value: string) {
  return value.toLowerCase().split(";", 1)[0].trim();
}

function isOpaqueEvidenceRef(value: string) {
  return value.length <= 512 && /^(?:evidence|urn):[A-Za-z0-9._~:/-]+$/.test(value);
}

function expectedContentType(kind: AssetKind) {
  if (kind === "overlay_background") return "image/png";
  if (kind === "portrait_photo") return "image/jpeg";
  return kind === "portrait" || kind === "product_clip" ? "video/mp4" : "audio/wav";
}
