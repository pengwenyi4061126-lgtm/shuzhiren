import { readFile } from "node:fs/promises";

const proxy = await readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8");
const commerceRoute = await readFile(new URL("../apps/console/app/api/v1/runtime/channel-commerce/route.ts", import.meta.url), "utf8");

if (!proxy.includes('request.nextUrl.pathname === "/api/v1/runtime/channel-commerce"')) throw new Error("Channel commerce ingest must bypass OIDC proxy authentication for its service-token boundary");
if (!commerceRoute.includes("requireChannelCommerceService(request, body.tenantId)")) throw new Error("Channel commerce ingest must enforce tenant-scoped service authentication inside the route");

console.log("PASS  channel commerce ingest uses the dedicated tenant service-token boundary");
