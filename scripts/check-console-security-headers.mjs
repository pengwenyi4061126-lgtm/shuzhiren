import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/console/next.config.ts", import.meta.url), "utf8");

for (const expected of [
  "Content-Security-Policy",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "Permissions-Policy",
  "Referrer-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  'source: "/:path*"'
]) {
  if (!source.includes(expected)) throw new Error(`Console security headers must retain ${expected}`);
}

console.log("PASS  console applies browser security headers to every route");
