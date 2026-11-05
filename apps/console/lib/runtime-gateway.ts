import { createHash } from "node:crypto";
import type { MediaCommand } from "@/lib/media-protocol";
import type { SpeechCommand } from "@/lib/speech-protocol";

type RuntimeGatewayConfig = { url?: string; token?: string; demoMode: boolean; requestTimeoutMs: number };
type RuntimeSessionObservation = { session: { id: string; active: boolean } };
export type RuntimePreview = { available: false; reason: "demo_mode" | "not_configured" | "session_inactive" } | { available: true; url: string; mode: "webrtc"; expiresAt: string };

function runtimeGatewayConfig(): RuntimeGatewayConfig {
  const url = process.env.RUNTIME_GATEWAY_URL;
  const token = process.env.RUNTIME_SHARED_TOKEN;
  const demoMode = process.env.RUNTIME_GATEWAY_DEMO_MODE === "true" || (process.env.NODE_ENV !== "production" && !url);
  const requestTimeoutMs = runtimeGatewayRequestTimeoutMs();
  if (process.env.NODE_ENV === "production" && (!url || !token || demoMode)) throw new Error("Production runtime gateway requires URL, token, and disabled demo mode");
  return { url, token, demoMode, requestTimeoutMs };
}

function runtimeGatewayRequestTimeoutMs() {
  const value = Number.parseInt(process.env.RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS ?? "20000", 10);
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Error("RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS must be an integer between 100 and 60000");
  return value;
}

export async function runtimeGatewayHealth() {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { status: "demo" as const };
  const response = await fetch(`${config.url}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error(`Runtime gateway health check failed: ${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error("runtime_gateway_health_invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("runtime_gateway_health_not_object");
  return { status: "ok" as const, ...(body as Record<string, unknown>) };
}

export async function observeRuntimeSession(sessionId: string): Promise<RuntimeSessionObservation> {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { session: { id: sessionId, active: true } };
  const response = await fetch(`${config.url}/v1/observations/${encodeURIComponent(sessionId)}`, { cache: "no-store", headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error(`Runtime session observation failed: ${response.status}`);
  const body = await response.json() as { session?: unknown };
  const session = body.session;
  if (!session || typeof session !== "object" || typeof (session as { id?: unknown }).id !== "string" || typeof (session as { active?: unknown }).active !== "boolean") throw new Error("Runtime session observation response is invalid");
  return { session: session as RuntimeSessionObservation["session"] };
}

export async function getRuntimePreview(sessionId: string): Promise<RuntimePreview> {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { available: false, reason: "demo_mode" };
  const response = await fetch(`${config.url}/v1/previews/${encodeURIComponent(sessionId)}`, { cache: "no-store", headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error(`Runtime preview request failed: ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  if (body.available === false && (body.reason === "not_configured" || body.reason === "session_inactive")) return { available: false, reason: body.reason };
  if (body.available !== true || typeof body.url !== "string" || body.mode !== "webrtc" || typeof body.expiresAt !== "string") throw new Error("Runtime preview response is invalid");
  const url = previewUrl(body.url);
  const expiresAt = new Date(body.expiresAt);
  const remainingMs = expiresAt.getTime() - Date.now();
  if (!url || Number.isNaN(expiresAt.getTime()) || remainingMs < 15_000 || remainingMs > 3_600_000) throw new Error("Runtime preview response is invalid");
  return { available: true, url, mode: "webrtc", expiresAt: expiresAt.toISOString() };
}

function previewUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
}

// Options for an outbox delivery: `timeoutMs` caps the request below the delivery lease so a request never
// outlives the claim that authorised it, and `notBefore` (the outbox event's created_at) lets a retry accept
// the Gateway's receipt of the first acceptance however old it is, as long as it is not older than the event.
export type DispatchOptions = { timeoutMs?: number; notBefore?: string };
const RECEIPT_CLOCK_SKEW_MS = 30_000;
function requestSignal(config: RuntimeGatewayConfig, options?: DispatchOptions) {
  const budget = options?.timeoutMs;
  return AbortSignal.timeout(budget === undefined ? config.requestTimeoutMs : Math.max(1, Math.min(config.requestTimeoutMs, Math.floor(budget))));
}

export async function dispatchMediaCommand(command: MediaCommand, sessionId: string, options?: DispatchOptions) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const, provider: { accepted: true, command_id: command.id, session_id: sessionId, action: command.type, receipt: { command_id: command.id, session_id: sessionId, action: command.type, accepted_at: new Date().toISOString(), evidence: "demo_gateway" } } };
  const programSegmentId = command.payload.programSegmentId;
  const runtimeScript = command.payload.runtimeScript;
  const scriptSha256 = command.payload.scriptSha256;
  if (command.type === "insert_program" && (!programSegmentIdValid(programSegmentId) || !runtimeScript || !/^[a-f0-9]{64}$/i.test(scriptSha256 ?? ""))) throw new Error("Program insertion command is missing frozen script evidence");
  if (command.type === "start_program" && ((runtimeScript && (!programSegmentIdValid(programSegmentId) || !/^[a-f0-9]{64}$/i.test(scriptSha256 ?? ""))) || (!runtimeScript && (programSegmentId || scriptSha256)))) throw new Error("Program start command contains incomplete frozen script evidence");
  if (command.type === "resume_program" && ((runtimeScript && (!programSegmentIdValid(programSegmentId) || !/^[a-f0-9]{64}$/i.test(scriptSha256 ?? ""))) || (!runtimeScript && (programSegmentId || scriptSha256)))) throw new Error("Program resume command contains incomplete frozen script evidence");
  if (runtimeScript && createHash("sha256").update(runtimeScript).digest("hex") !== scriptSha256) throw new Error("Program script hash does not match frozen script");
  if (command.type !== "start_program" && command.type !== "insert_program" && command.type !== "resume_program" && (programSegmentId || runtimeScript || scriptSha256)) throw new Error("Non-program media command cannot include a runtime script");
  // The Gateway synthesizes a script only with the frozen approved voice (CosyVoice) and rejects one without it.
  const runtimeVoiceId = command.payload.runtimeVoiceId;
  const voiceChecksum = command.payload.voiceChecksum;
  if (runtimeScript && (!runtimeVoiceIdValid(runtimeVoiceId) || !voiceChecksumValid(voiceChecksum))) throw new Error("Program command is missing its frozen voice binding");
  if (!runtimeScript && (runtimeVoiceId !== undefined || voiceChecksum !== undefined)) throw new Error("Only a program command with a script may carry a voice");
  const response = await fetch(`${config.url}/v1/media`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, action: command.type, ...(programSegmentId ? { program_segment_id: programSegmentId } : {}), ...(runtimeScript ? { program_script: runtimeScript } : {}), ...(scriptSha256 ? { script_sha256: scriptSha256 } : {}), ...(runtimeScript ? { runtime_voice_id: runtimeVoiceId, voice_checksum: voiceChecksum } : {}) }),
    signal: requestSignal(config, options)
  });
  if (!response.ok) throw new Error(`Runtime gateway rejected media command: ${response.status}`);
  const provider = await response.json() as unknown;
  assertMediaGatewayReceipt(provider, command, sessionId, options?.notBefore);
  return { delivery: "accepted" as const, provider };
}

function receiptTimeAcceptable(acceptedAt: Date, notBefore?: string) {
  const accepted = acceptedAt.getTime();
  if (notBefore === undefined) return Math.abs(Date.now() - accepted) <= 5 * 60_000;
  const floor = new Date(notBefore).getTime() - RECEIPT_CLOCK_SKEW_MS;
  return !Number.isNaN(floor) && accepted >= floor && accepted <= Date.now() + RECEIPT_CLOCK_SKEW_MS;
}

function assertMediaGatewayReceipt(value: unknown, command: MediaCommand, sessionId: string, notBefore?: string) {
  if (!value || typeof value !== "object") throw new Error("Runtime gateway returned an invalid media receipt");
  const receipt = (value as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object") throw new Error("Runtime gateway returned an invalid media receipt");
  const fields = receipt as Record<string, unknown>;
  const acceptedAt = typeof fields.accepted_at === "string" ? new Date(fields.accepted_at) : undefined;
  if ((value as { accepted?: unknown }).accepted !== true || fields.command_id !== command.id || fields.session_id !== sessionId || fields.action !== command.type || !acceptedAt || Number.isNaN(acceptedAt.getTime()) || !receiptTimeAcceptable(acceptedAt, notBefore)) throw new Error("Runtime gateway receipt does not bind the media command");
  if (command.payload.programSegmentId && fields.program_segment_id !== command.payload.programSegmentId) throw new Error("Runtime gateway receipt does not bind the program segment");
}

function programSegmentIdValid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function runtimeVoiceIdValid(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function voiceChecksumValid(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value); }

export async function dispatchSpeechCommand(command: SpeechCommand, sessionId: string, options?: DispatchOptions) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const };
  if (!runtimeVoiceIdValid(command.voice) || !voiceChecksumValid(command.voiceChecksum)) throw new Error("Speech command is missing its frozen voice binding");
  const response = await fetch(`${config.url}/v1/speak`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, text: command.text, voice: command.voice, voice_checksum: command.voiceChecksum, interrupt: command.interrupt, provider: "cosyvoice" }),
    signal: requestSignal(config, options)
  });
  if (!response.ok) throw new Error(`Runtime gateway rejected speech command: ${response.status}`);
  return { delivery: "accepted" as const, provider: await response.json() as unknown };
}
