import { createHash, timingSafeEqual } from "node:crypto";

type TenantServiceTokenVariable = "RUNTIME_TELEMETRY_TENANT_TOKENS" | "PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS" | "RUNTIME_RECORDING_TENANT_TOKENS" | "PIM_INGEST_TENANT_TOKENS" | "CHANNEL_INGEST_TENANT_TOKENS" | "CHANNEL_COMMERCE_TENANT_TOKENS" | "SETTLEMENT_INGEST_TENANT_TOKENS";

export const TENANT_TOKEN_VARIABLES: readonly TenantServiceTokenVariable[] = ["RUNTIME_TELEMETRY_TENANT_TOKENS", "PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS", "RUNTIME_RECORDING_TENANT_TOKENS", "PIM_INGEST_TENANT_TOKENS", "CHANNEL_INGEST_TENANT_TOKENS", "CHANNEL_COMMERCE_TENANT_TOKENS", "SETTLEMENT_INGEST_TENANT_TOKENS"];

export type TenantTokenMapReason = "invalid_json" | "not_object" | "empty_object" | "key_empty" | "key_too_long" | "value_not_string" | "value_too_short" | "value_whitespace";
export type TenantTokenMapResult = { ok: true; map: Map<string, string> } | { ok: false; reason: TenantTokenMapReason; entryIndex?: number };

// One malformed entry invalidates the whole map: silently dropping it would
// leave a tenant's ingest path unauthorized without any configuration error.
export function parseTenantTokenMap(raw: string): TenantTokenMapResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: "invalid_json" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not_object" };
  const entries = Object.entries(parsed);
  if (!entries.length) return { ok: false, reason: "empty_object" };
  const tokens = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const entryIndex = index + 1;
    if (entry[0].length === 0) return { ok: false, reason: "key_empty", entryIndex };
    if (entry[0].length > 200) return { ok: false, reason: "key_too_long", entryIndex };
    if (typeof entry[1] !== "string") return { ok: false, reason: "value_not_string", entryIndex };
    if (entry[1].length < 32) return { ok: false, reason: "value_too_short", entryIndex };
    if (/\s/.test(entry[1])) return { ok: false, reason: "value_whitespace", entryIndex };
    tokens.set(entry[0], entry[1]);
  }
  return { ok: true, map: tokens };
}

const tokenMapReasonText: Record<TenantTokenMapReason, string> = {
  invalid_json: "is not valid JSON",
  not_object: "must be a JSON object mapping tenant ids to tokens",
  empty_object: "must contain at least one tenant token",
  key_empty: "tenant id is empty",
  key_too_long: "tenant id is longer than 200 characters",
  value_not_string: "value is not a string",
  value_too_short: "value is shorter than 32 characters",
  value_whitespace: "value contains whitespace"
};

// Messages name only the variable, the entry position and the reason; never a
// tenant id, a token, or JSON.parse output (which quotes the input).
export function validateTenantTokenEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return TENANT_TOKEN_VARIABLES.flatMap((variable) => {
    const raw = env[variable];
    if (!raw) return [];
    const result = parseTenantTokenMap(raw);
    if (result.ok) return [];
    return [`${variable} is invalid: ${result.entryIndex ? `entry ${result.entryIndex} ` : ""}${tokenMapReasonText[result.reason]}`];
  });
}

// Called from instrumentation register(): a misconfigured map stops the
// process before it serves a request instead of failing tenants one by one.
export function enforceTenantTokenEnvironment() {
  const errors = validateTenantTokenEnvironment(process.env);
  if (!errors.length) return;
  for (const message of errors) process.stderr.write(`ERROR ${message}\n`);
  process.exit(1);
}

function configuredTenantTokens(variable: TenantServiceTokenVariable, developmentToken: string, label: string) {
  const value = process.env[variable];
  if (!value) {
    if (process.env.NODE_ENV === "production") throw new Response(`${label} tenant token map is not configured`, { status: 503 });
    return new Map([["tenant_demo", developmentToken]]);
  }
  const parsed = parseTenantTokenMap(value);
  if (!parsed.ok) throw new Response(`${label} tenant token map is invalid`, { status: 503 });
  return parsed.map;
}

// Compares fixed-length SHA-256 digests with timingSafeEqual, so the time taken
// does not depend on how much of the presented header matches the expected
// value, and headers of a different length (or with non-ASCII bytes) simply
// do not match.
export function tokenMatches(authorization: string | null, expected: string) {
  const presented = createHash("sha256").update(authorization ?? "", "utf8").digest();
  const wanted = createHash("sha256").update(`Bearer ${expected}`, "utf8").digest();
  return timingSafeEqual(presented, wanted);
}

function requireTenantService(request: Request, tenantId: string, variable: TenantServiceTokenVariable, developmentToken: string, label: string) {
  const expected = configuredTenantTokens(variable, developmentToken, label).get(tenantId);
  // Compare even when the tenant has no token so both rejections cost the same.
  const matches = tokenMatches(request.headers.get("authorization"), expected ?? "");
  if (!expected || !matches) throw new Response(`Invalid ${label} token`, { status: 401 });
}

export function requireRuntimeService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "RUNTIME_TELEMETRY_TENANT_TOKENS", "demo-runtime-token", "runtime service"); }
export function requireProgramOutputObservationService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "PROGRAM_OUTPUT_OBSERVATION_TENANT_TOKENS", "demo-program-output-observation-token", "program output observation service"); }
export function requireRuntimeRecordingService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "RUNTIME_RECORDING_TENANT_TOKENS", "demo-runtime-recording-token", "runtime recording service"); }
export function requirePimIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "PIM_INGEST_TENANT_TOKENS", "demo-pim-ingest-token", "PIM ingest service"); }
export function requireChannelIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "CHANNEL_INGEST_TENANT_TOKENS", "demo-channel-ingest-token", "channel ingest service"); }
export function requireChannelCommerceService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "CHANNEL_COMMERCE_TENANT_TOKENS", "demo-channel-commerce-token", "channel commerce service"); }
export function requireSettlementIngestService(request: Request, tenantId: string) { requireTenantService(request, tenantId, "SETTLEMENT_INGEST_TENANT_TOKENS", "demo-settlement-ingest-token", "settlement ingest service"); }
