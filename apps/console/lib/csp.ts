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

export function mediaUploadOrigins(value = process.env.MEDIA_UPLOAD_ALLOWED_ORIGINS ?? "", development = process.env.NODE_ENV === "development") {
  const entries = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  const origins = entries.map((entry) => {
    let url: URL;
    try { url = new URL(entry); } catch { throw new Error("MEDIA_UPLOAD_ALLOWED_ORIGINS is invalid"); }
    const loopbackHttp = development && url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.origin !== entry || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !loopbackHttp)) {
      throw new Error("MEDIA_UPLOAD_ALLOWED_ORIGINS must contain only credential-free HTTPS origins (or loopback HTTP in development)");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

// script-src has no 'unsafe-inline': only scripts carrying the nonce (and,
// through 'strict-dynamic', the scripts they load) run. style-src keeps
// 'unsafe-inline' without a nonce because a nonce in the directive would make
// browsers ignore 'unsafe-inline' and block React style attributes.
export function pageCsp(nonce: string, options: { development?: boolean; mediaUploadOrigins?: string[] } = {}) {
  const connectOrigins = [...new Set([...(options.mediaUploadOrigins ?? []), ...(options.development ? ["http://127.0.0.1:9000"] : [])])];
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
    `connect-src 'self'${connectOrigins.length ? ` ${connectOrigins.join(" ")}` : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:"
  ].join("; ");
}

export const apiCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// One year, without includeSubDomains or preload so that other hosts under the
// deployer's domain are not affected.
export const strictTransportSecurity = "max-age=31536000";
