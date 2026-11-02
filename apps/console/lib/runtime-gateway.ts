import type { MediaCommand } from "@/lib/media-protocol";
import type { SpeechCommand } from "@/lib/speech-protocol";

type RuntimeGatewayConfig = { url?: string; token?: string; demoMode: boolean };

function runtimeGatewayConfig(): RuntimeGatewayConfig {
  const url = process.env.RUNTIME_GATEWAY_URL;
  const token = process.env.RUNTIME_SHARED_TOKEN;
  const demoMode = process.env.RUNTIME_GATEWAY_DEMO_MODE === "true" || (process.env.NODE_ENV !== "production" && !url);
  if (process.env.NODE_ENV === "production" && (!url || !token || demoMode)) throw new Error("Production runtime gateway requires URL, token, and disabled demo mode");
  return { url, token, demoMode };
}

export async function runtimeGatewayHealth() {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { status: "demo" as const };
  const response = await fetch(`${config.url}/healthz`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Runtime gateway health check failed: ${response.status}`);
  return { status: "ok" as const, ...(await response.json() as Record<string, unknown>) };
}

export async function dispatchMediaCommand(command: MediaCommand, sessionId: string) {
  const config = runtimeGatewayConfig();
  if (config.demoMode) return { delivery: "demo" as const };
  const response = await fetch(`${config.url}/v1/media`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, action: command.type })
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
    body: JSON.stringify({ command_id: command.id, session_id: sessionId, text: command.text, voice: command.voice, interrupt: command.interrupt })
  });
  if (!response.ok) throw new Error(`Runtime gateway rejected speech command: ${response.status}`);
  return { delivery: "accepted" as const, provider: await response.json() as unknown };
}
