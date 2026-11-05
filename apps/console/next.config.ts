import type { NextConfig } from "next";
import { apiCsp, strictTransportSecurity } from "./lib/csp";

// Page Content-Security-Policy headers carry a per-request nonce and are set by
// proxy.ts only; a second, static page policy here would also be enforced and
// block the nonce-bearing scripts. API routes get a policy that loads nothing.
const securityHeaders = [
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // headers() is evaluated by `next build`, where NODE_ENV is production, so
  // built servers always send HSTS while `next dev` does not.
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: strictTransportSecurity }] : [])
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] }
    ];
  }
};

export default nextConfig;
