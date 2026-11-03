import type { MediaCommand } from "@/lib/media-protocol";
import type { SpeechCommand } from "@/lib/speech-protocol";

type RuntimeGatewayConfig = { url?: string; token?: string; demoMode: boolean; requestTimeoutMs: number };
type RuntimeSessionObservation = { session: { id: string; active: boolean } };

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
  return { status: "ok" as const, ...(await response.json() as Record<string, unknown>) };
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

export async function dispatchMediaCommand(command: MediaCommand, sessionId: string) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const };
  const response = await fetch(`${config.url}/v1/media`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, action: command.type }),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Runtime gateway rejected media command: ${response.status}`);
  return { delivery: "accepted" as const, provider: await response.json() as unknown };
}

export async function dispatchSpeechCommand(command: SpeechCommand, sessionId: string) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const };
  const response = await fetch(`${config.url}/v1/speak`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, text: command.text, voice: command.voice, interrupt: command.interrupt }),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Runtime gateway rejected speech command: ${response.status}`);
  return { delivery: "accepted" as const, provider: await response.json() as unknown };
}
