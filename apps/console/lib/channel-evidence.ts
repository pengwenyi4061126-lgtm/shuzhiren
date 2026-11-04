import { createHash } from "node:crypto";
import { controlPlaneConfig } from "@/lib/control-plane/config";
import { isControlledEvidenceRef } from "@/lib/governance-input";
import type { ChannelConnection } from "@/lib/channels";

type ChannelVerificationAttestation = { evidenceRef: string; verifiedAt: string };
type VerifierConfig = { url?: string; token?: string; demoMode: boolean; timeoutMs: number };

export async function verifyChannelConnectionEvidence(context: { tenantId: string }, channel: ChannelConnection): Promise<ChannelVerificationAttestation> {
  const config = verifierConfig();
  if (config.demoMode) return { evidenceRef: "evidence://demo/channel-verification", verifiedAt: new Date().toISOString() };
  const response = await fetch(`${config.url}/v1/channel-evidence/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ tenantId: context.tenantId, channelConnectionId: channel.id, provider: channel.provider, outputProtocol: channel.outputProtocol, capability: channel.capability, secretRef: channel.secretRef, configurationSha256: channelConfigurationSha256(channel) }),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Response("Channel evidence verification failed", { status: 502 });
  return validateAttestation(await response.json(), channel);
}

function verifierConfig(): VerifierConfig {
  const config = controlPlaneConfig();
  const url = process.env.CHANNEL_EVIDENCE_VERIFIER_URL;
  const token = process.env.CHANNEL_EVIDENCE_VERIFIER_TOKEN;
  const timeoutMs = boundedTimeout();
  if (config.demoMode) return { demoMode: true, timeoutMs };
  if (!url || !token) throw new Response("Channel evidence verifier is not configured", { status: 503 });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Response("Channel evidence verifier configuration is invalid", { status: 503 }); }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== "https:" && !loopbackHttp) || token.length < 32 || /\s/.test(token)) throw new Response("Channel evidence verifier configuration is invalid", { status: 503 });
  return { url: url.replace(/\/$/, ""), token, demoMode: false, timeoutMs };
}

function boundedTimeout() {
  const value = Number.parseInt(process.env.CHANNEL_EVIDENCE_VERIFIER_TIMEOUT_MS ?? "5000", 10);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Response("Channel evidence verifier configuration is invalid", { status: 503 });
  return value;
}

function validateAttestation(value: unknown, channel: ChannelConnection): ChannelVerificationAttestation {
  if (!value || typeof value !== "object") throw new Response("Channel evidence verifier response is invalid", { status: 502 });
  const proof = value as Record<string, unknown>;
  if (proof.channelConnectionId !== channel.id || proof.configurationSha256 !== channelConfigurationSha256(channel) || typeof proof.evidenceRef !== "string" || !isControlledEvidenceRef(proof.evidenceRef) || typeof proof.verifiedAt !== "string") throw new Response("Channel evidence verifier response is invalid", { status: 502 });
  const verifiedAt = new Date(proof.verifiedAt);
  const age = Date.now() - verifiedAt.getTime();
  if (Number.isNaN(verifiedAt.getTime()) || age < -60_000 || age > 10 * 60_000) throw new Response("Channel evidence verifier response is invalid", { status: 502 });
  return { evidenceRef: proof.evidenceRef, verifiedAt: verifiedAt.toISOString() };
}

function channelConfigurationSha256(channel: ChannelConnection) {
  return createHash("sha256").update(JSON.stringify({ id: channel.id, provider: channel.provider, outputProtocol: channel.outputProtocol, capability: channel.capability, secretRef: channel.secretRef })).digest("hex");
}
