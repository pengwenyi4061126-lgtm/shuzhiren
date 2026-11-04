type TenantServiceTokenVariable = "RUNTIME_TELEMETRY_TENANT_TOKENS" | "RUNTIME_RECORDING_TENANT_TOKENS" | "PIM_INGEST_TENANT_TOKENS" | "CHANNEL_INGEST_TENANT_TOKENS" | "CHANNEL_COMMERCE_TENANT_TOKENS" | "SETTLEMENT_INGEST_TENANT_TOKENS";

function configuredTenantTokens(variable: TenantServiceTokenVariable, developmentToken: string, label: string) {
  const value = process.env[variable];
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Response(`${label} tenant token map is not configured`, { status: 503 });
    return new Map([["tenant_demo", developmentToken]]);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const tokens = new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === "string" && entry[0].length > 0 && entry[0].length <= 200 && typeof entry[1] === "string" && entry[1].length >= 32 && !/\s/.test(entry[1])));
    if (!tokens.size) throw new Error("no valid tenant token");
    return tokens;
  } catch {
    throw new Response(`${label} tenant token map is invalid`, { status: 503 });
  }
}

function requireTenantService(request: Request, tenantId: string, variable: TenantServiceTokenVariable, developmentToken: string, label: string) {
  const expected = configuredTenantTokens(variable, developmentToken, label).get(tenantId);
  const authorization = request.headers.get("authorization");
  if (!expected) throw new Response(`No ${label} token is authorized for this tenant`, { status: 401 });
  if (authorization !== `Bearer ${expected}`) throw new Response(`Invalid ${label} token`, { status: 401 });
}

export function requireRuntimeService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "RUNTIME_TELEMETRY_TENANT_TOKENS", "demo-runtime-token", "runtime service"); }
export function requireRuntimeRecordingService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "RUNTIME_RECORDING_TENANT_TOKENS", "demo-runtime-recording-token", "runtime recording service"); }
export function requirePimIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "PIM_INGEST_TENANT_TOKENS", "demo-pim-ingest-token", "PIM ingest service"); }
export function requireChannelIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "CHANNEL_INGEST_TENANT_TOKENS", "demo-channel-ingest-token", "channel ingest service"); }
export function requireChannelCommerceService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "CHANNEL_COMMERCE_TENANT_TOKENS", "demo-channel-commerce-token", "channel commerce service"); }
export function requireSettlementIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "SETTLEMENT_INGEST_TENANT_TOKENS", "demo-settlement-ingest-token", "settlement ingest service"); }
