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

/** True when the console runs without a Runtime Gateway (development only; production configuration throws). */
export function runtimeGatewayDemoMode() {
  return runtimeGatewayConfig().demoMode;
}

// options.timeoutMs caps the request below RUNTIME_GATEWAY_REQUEST_TIMEOUT_MS; options.acceptDegraded also returns
// the body of a 503 degraded answer (the AIGC label preflight reads dependencies.livetalking.aigc_label from it).
export async function runtimeGatewayHealth(options: { timeoutMs?: number; acceptDegraded?: boolean } = {}) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { status: "demo" as const };
  const timeoutMs = options.timeoutMs === undefined ? config.requestTimeoutMs : Math.max(1, Math.min(config.requestTimeoutMs, Math.floor(options.timeoutMs)));
  const response = await fetch(`${config.url}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok && !(options.acceptDegraded && response.status === 503)) throw new Error(`Runtime gateway health check failed: ${response.status}`);
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
// A non-2xx Gateway answer. `code` is the top-level machine-readable code of the Gateway's error body
// (Requirement 19), for example command_outcome_uncertain or command_failed_definite; it is undefined when the
// body has none. The error body's other fields are not kept: they may carry upstream diagnostics.
export class RuntimeGatewayError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) { super(message); this.name = "RuntimeGatewayError"; }
}
const gatewayCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
async function gatewayError(response: Response, message: string) {
  const body = await response.json().catch(() => null) as unknown;
  const code = body && typeof body === "object" && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
  const gatewayCode = typeof code === "string" && gatewayCodePattern.test(code) ? code : undefined;
  return new RuntimeGatewayError(`${message}: ${response.status}${gatewayCode ? ` ${gatewayCode}` : ""}`, response.status, gatewayCode);
}
const RECEIPT_CLOCK_SKEW_MS = 30_000;
function requestSignal(config: RuntimeGatewayConfig, options?: DispatchOptions) {
  const budget = options?.timeoutMs;
  return AbortSignal.timeout(budget === undefined ? config.requestTimeoutMs : Math.max(1, Math.min(config.requestTimeoutMs, Math.floor(budget))));
}

export async function dispatchMediaCommand(command: MediaCommand, sessionId: string, options?: DispatchOptions) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const, provider: { accepted: true, command_id: command.id, session_id: sessionId, action: command.type, receipt: { command_id: command.id, session_id: sessionId, action: command.type, accepted_at: new Date().toISOString(), evidence: "demo_gateway" } } };
  const overlaySceneJson = command.payload.overlaySceneJson;
  const overlaySceneSha256 = command.payload.overlaySceneSha256;
  if ((overlaySceneJson === undefined) !== (overlaySceneSha256 === undefined)) throw new Error("Overlay scene JSON and SHA-256 must be provided together");
  if (overlaySceneJson !== undefined && (command.type !== "start_program" || createHash("sha256").update(overlaySceneJson, "utf8").digest("hex") !== overlaySceneSha256)) throw new Error("Overlay scene hash does not match the start command");
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
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, action: command.type, ...(programSegmentId ? { program_segment_id: programSegmentId } : {}), ...(runtimeScript ? { program_script: runtimeScript } : {}), ...(scriptSha256 ? { script_sha256: scriptSha256 } : {}), ...(runtimeScript ? { runtime_voice_id: runtimeVoiceId, voice_checksum: voiceChecksum } : {}), ...(overlaySceneJson !== undefined ? { overlay_scene_json: overlaySceneJson, overlay_scene_sha256: overlaySceneSha256 } : {}) }),
    signal: requestSignal(config, options)
  });
  if (!response.ok) throw await gatewayError(response, "Runtime gateway rejected media command");
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
  if (command.payload.overlaySceneSha256 && fields.overlay_scene_sha256 !== command.payload.overlaySceneSha256) throw new Error("Runtime gateway receipt does not bind the media command");
}

function programSegmentIdValid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function runtimeVoiceIdValid(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function voiceChecksumValid(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value); }

export async function synthesizeRuntimeSpeechPreview(text: string, voice: string, voiceChecksum: string) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) throw new RuntimeGatewayError("Speech synthesis requires a configured Runtime Gateway", 503, "runtime_gateway_demo_mode");
  if (!text.trim() || text.length > 12000 || !runtimeVoiceIdValid(voice) || !voiceChecksumValid(voiceChecksum)) throw new Error("Speech preview request is invalid");
  const response = await fetch(`${config.url}/v1/synthesize`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ text, voice, voice_checksum: voiceChecksum }),
    signal: AbortSignal.timeout(Math.max(config.requestTimeoutMs, 60_000))
  });
  if (!response.ok) throw await gatewayError(response, "Runtime Gateway rejected speech preview");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/wav")) throw new Error("Runtime Gateway returned an invalid speech preview");
  const audio = await response.arrayBuffer();
  const signature = new TextDecoder().decode(audio.slice(0, 4));
  const format = new TextDecoder().decode(audio.slice(8, 12));
  if (audio.byteLength < 44 || audio.byteLength > 4_400_000 || signature !== "RIFF" || format !== "WAVE") throw new Error("Runtime Gateway returned an invalid WAV preview");
  return new Blob([audio], { type: "audio/wav" });
}

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
  if (!response.ok) throw await gatewayError(response, "Runtime gateway rejected speech command");
  return { delivery: "accepted" as const, provider: await response.json() as unknown };
}
// Operator routes of the Gateway's Command_Journal (Requirement 19.9-19.11). The console calls them with
// RUNTIME_SHARED_TOKEN on the server; the browser never sees the token.
export type UncertainRuntimeCommand = {
  commandId: string;
  kind: "media" | "speech";
  reservedAt: string | null;
  uncertainAt: string | null;
  reason: string | null;
  sessionId: string | null;
  action: string | null;
  programSegmentId: string | null;
  succeededSteps: string[];
  failedStep: string | null;
  identityAvailable: boolean;
};
export type RuntimeCommandResolution = "completed" | "failed_definite";
export type RuntimeCommandResolutionResult = { commandId: string; previousState: string; state: RuntimeCommandResolution; resolvedAt: string };
// The Gateway's COMMAND_ID_PATTERN.
const runtimeCommandIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function runtimeCommandIdValid(value: unknown): value is string { return typeof value === "string" && runtimeCommandIdPattern.test(value); }
export async function listUncertainRuntimeCommands(): Promise<UncertainRuntimeCommand[]> {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return [];
  const response = await fetch(`${config.url}/v1/ops/uncertain-commands`, { cache: "no-store", headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw await gatewayError(response, "Runtime gateway uncertain command list failed");
  const body = await response.json().catch(() => null) as { commands?: unknown } | null;
  if (!body || !Array.isArray(body.commands)) throw new Error("Runtime gateway uncertain command list is invalid");
  return body.commands.map(uncertainRuntimeCommand);
}
function uncertainRuntimeCommand(value: unknown): UncertainRuntimeCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime gateway uncertain command list is invalid");
  const item = value as Record<string, unknown>;
  if (!runtimeCommandIdValid(item.command_id) || (item.kind !== "media" && item.kind !== "speech")) throw new Error("Runtime gateway uncertain command list is invalid");
  const text = (field: unknown) => typeof field === "string" ? field : null;
  return {
    commandId: item.command_id,
    kind: item.kind,
    reservedAt: text(item.reserved_at),
    uncertainAt: text(item.uncertain_at),
    reason: text(item.reason),
    sessionId: text(item.session_id),
    action: text(item.action),
    programSegmentId: text(item.program_segment_id),
    succeededSteps: Array.isArray(item.succeeded_steps) ? item.succeeded_steps.filter((step): step is string => typeof step === "string") : [],
    failedStep: text(item.failed_step),
    identityAvailable: item.identity_available === true
  };
}
export async function resolveUncertainRuntimeCommand(commandId: string, resolution: RuntimeCommandResolution, note: string): Promise<RuntimeCommandResolutionResult> {
  const config = runtimeGatewayConfig();
  if (config.demoMode) throw new RuntimeGatewayError("Runtime gateway is in demo mode", 404, "command_not_found");
  if (!runtimeCommandIdValid(commandId)) throw new RuntimeGatewayError("Runtime command was not found", 404, "command_not_found");
  const response = await fetch(`${config.url}/v1/ops/uncertain-commands/${encodeURIComponent(commandId)}/resolution`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ resolution, note }),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  if (!response.ok) throw await gatewayError(response, "Runtime gateway rejected the resolution");
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.command_id !== commandId || body.state !== resolution || typeof body.previous_state !== "string" || typeof body.resolved_at !== "string") throw new Error("Runtime gateway resolution response is invalid");
  return { commandId, previousState: body.previous_state, state: resolution, resolvedAt: body.resolved_at };
}
