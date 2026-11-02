function requireServiceToken(request: Request, variable: "RUNTIME_TELEMETRY_TOKEN" | "CHANNEL_INGEST_TOKEN", developmentToken: string, label: string) {
  const expected = process.env[variable] ?? (process.env.NODE_ENV === "production" ? undefined : developmentToken);
  const authorization = request.headers.get("authorization");
  if (!expected) throw new Response(`${label} token is not configured`, { status: 503 });
  if (authorization !== `Bearer ${expected}`) throw new Response(`Invalid ${label} token`, { status: 401 });
}

export function requireRuntimeService(request: Request) { requireServiceToken(request, "RUNTIME_TELEMETRY_TOKEN", "demo-runtime-token", "runtime service"); }
export function requireChannelIngestService(request: Request) { requireServiceToken(request, "CHANNEL_INGEST_TOKEN", "demo-channel-ingest-token", "channel ingest service"); }
