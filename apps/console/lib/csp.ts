// Content-Security-Policy values for the console. Pages get a per-request nonce
// (set by proxy.ts, which Next.js reads back from the request CSP header and
// applies to its framework and inline scripts); API responses get a policy
// that allows nothing to load.

// 16 bytes (128 bits) from the platform CSPRNG, base64 encoded.
export function generateNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// script-src has no 'unsafe-inline': only scripts carrying the nonce (and,
// through 'strict-dynamic', the scripts they load) run. style-src keeps
// 'unsafe-inline' without a nonce because a nonce in the directive would make
// browsers ignore 'unsafe-inline' and block React style attributes.
export function pageCsp(nonce: string, options: { development?: boolean } = {}) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:"
  ].join("; ");
}

export const apiCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// One year, without includeSubDomains or preload so that other hosts under the
// deployer's domain are not affected.
export const strictTransportSecurity = "max-age=31536000";
