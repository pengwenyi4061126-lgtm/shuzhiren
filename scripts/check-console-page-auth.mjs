import { readFile } from "node:fs/promises";

const [proxy, pageContext] = await Promise.all([
  readFile(new URL("../apps/console/proxy.ts", import.meta.url), "utf8"),
  readFile(new URL("../apps/console/lib/control-plane/page-context.ts", import.meta.url), "utf8")
]);

for (const source of ["api/health(?:/.*)?", "_next/static", "_next/image", "favicon.ico"]) {
  if (!proxy.includes(source)) throw new Error(`Console proxy must explicitly exclude unauthenticated infrastructure route: ${source}`);
}
if (!proxy.includes('matcher: ["/((?!api/health(?:/.*)?|_next/static|_next/image|favicon.ico).*)"]')) {
  throw new Error("Console proxy must authenticate both pages and API routes before rendering data");
}
if (!pageContext.includes("requestContextFrom")) throw new Error("Server-rendered pages must retain request-context authorization");
for (const source of ["const remoteJwks = new Map", "jwksFor(jwksUrl)", "timeoutDuration: 5_000"]) {
  if (!proxy.includes(source)) throw new Error(`Console proxy must cache bounded remote JWKS verification: ${source}`);
}

console.log("PASS  console pages and API routes share the production authentication boundary");
