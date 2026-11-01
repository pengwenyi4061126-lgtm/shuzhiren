export function requireRuntimeService(request: Request) {
  const expected = process.env.RUNTIME_TELEMETRY_TOKEN ?? (process.env.NODE_ENV === "production" ? undefined : "demo-runtime-token");
  const authorization = request.headers.get("authorization");
  if (!expected) throw new Response("Runtime telemetry token is not configured", { status: 503 });
  if (authorization !== `Bearer ${expected}`) throw new Response("Invalid runtime service token", { status: 401 });
}
