import { readFile } from "node:fs/promises";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const serviceAuth = await readFile(new URL("../apps/console/lib/runtime-service-auth.ts", import.meta.url), "utf8");
const protectedServiceRoutes = [
  ["/api/v1/runtime/telemetry", "../apps/console/app/api/v1/runtime/telemetry/route.ts", "requireRuntimeService(request, body.tenantId)"],
  ["/api/v1/runtime/recordings", "../apps/console/app/api/v1/runtime/recordings/route.ts", "requireRuntimeRecordingService(request, body.tenantId)"],
  ["/api/v1/integrations/product-facts", "../apps/console/app/api/v1/integrations/product-facts/route.ts", "requirePimIngestService(request, body.tenantId)"],
  ["/api/v1/runtime/channel-interactions", "../apps/console/app/api/v1/runtime/channel-interactions/route.ts", "requireChannelIngestService(request, body.tenantId)"],
  ["/api/v1/runtime/channel-commerce", "../apps/console/app/api/v1/runtime/channel-commerce/route.ts", "requireChannelCommerceService(request, body.tenantId)"],
  ["/api/v1/runtime/settlement-batches", "../apps/console/app/api/v1/runtime/settlement-batches/route.ts", "requireSettlementIngestService(request, body.tenantId)"]
];

for (const [path, routePath, serviceGuard] of protectedServiceRoutes) {
  if (!proxy.includes(`request.nextUrl.pathname === "${path}"`)) throw new Error(`${path} must bypass OIDC proxy authentication for its service-token boundary`);
  const route = await readFile(new URL(routePath, import.meta.url), "utf8");
  if (!route.includes(serviceGuard)) throw new Error(`${path} must enforce tenant-scoped service authentication inside the route`);
}

if (!serviceAuth.includes("entry[1].length >= 32") || !serviceAuth.includes("!/\\s/.test(entry[1])")) throw new Error("private tenant service tokens must require at least 32 non-whitespace characters");

console.log("PASS  private ingest routes use dedicated tenant service-token boundaries");
