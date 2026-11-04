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

function contentTypeMatches(kind: AssetKind, value: string) {
  const type = normalizedContentType(value);
  return (kind === "portrait" || kind === "product_clip") ? type.startsWith("video/") : type.startsWith("audio/");
}

function normalizedContentType(value: string) {
  return value.toLowerCase().split(";", 1)[0].trim();
}

function isOpaqueEvidenceRef(value: string) {
  return value.length <= 512 && /^(?:evidence|urn):[A-Za-z0-9._~:/-]+$/.test(value);
}

function expectedContentType(kind: AssetKind) {
  return kind === "portrait" || kind === "product_clip" ? "video/mp4" : "audio/wav";
}
