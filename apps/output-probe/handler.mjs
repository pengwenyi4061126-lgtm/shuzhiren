import { createHash, timingSafeEqual } from "node:crypto";

const probePrefix = "/v1/probes/";

export function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** Returns the parsed request target, or null when it cannot be parsed (for example `//` or `//[`). */
export function parseRequestTarget(raw) {
  try { return new URL(raw ?? "/", "http://localhost"); } catch { return null; }
}

/** Returns the decoded probe id, or null when the percent-encoding is malformed (for example `%zz`). */
export function decodeTargetId(encoded) {
  try { return decodeURIComponent(encoded); } catch { return null; }
}

/** SHA-256 digest of the expected Authorization header value, computed once at startup. */
export function authorizationDigest(expectedHeaderValue) {
  return createHash("sha256").update(Buffer.from(expectedHeaderValue, "utf8")).digest();
}

/**
 * Compares two fixed-length digests with timingSafeEqual, so the comparison time does not depend on how many
 * leading characters match or on the supplied length. Node decodes header bytes as latin1, so the supplied
 * value is turned back into its raw bytes before hashing.
 */
export function authorizationMatches(header, expectedDigest) {
  const supplied = createHash("sha256").update(Buffer.from(typeof header === "string" ? header : "", "latin1")).digest();
  return timingSafeEqual(supplied, expectedDigest);
}

export function createProbeHandler({ token, targets, measure, log = defaultLog }) {
  const expectedDigest = authorizationDigest(`Bearer ${token}`);
  return async function handleProbeRequest(request, response) {
    const url = parseRequestTarget(request.url);
    if (!url) return json(response, 400, { error: "invalid_request_target" });
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { status: "ok", targetCount: targets.size });
    if (request.method !== "GET" || !url.pathname.startsWith(probePrefix)) return json(response, 404, { error: "not_found" });
    if (!authorizationMatches(request.headers.authorization, expectedDigest)) return json(response, 401, { error: "unauthorized" });
    const id = decodeTargetId(url.pathname.slice(probePrefix.length));
    if (id === null) return json(response, 400, { error: "invalid_probe_id" });
    const target = targets.get(id);
    if (!target) return json(response, 404, { error: "probe_not_found" });
    try {
      return json(response, 200, await measure(target));
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : "probe_failed";
      log({ service: "output-probe", event: "measurement_failed", targetId: target.id, diagnostic });
      return json(response, 503, { error: "measurement_unavailable" });
    }
  };
}

/**
 * Wraps a request handler so that synchronous throws and rejected promises produce a generic 500 response
 * (or, once headers were sent, destroy only the affected socket) instead of an unhandled rejection that
 * would terminate the process.
 */
export function guardedHandler(handler, { log = defaultLog } = {}) {
  return (request, response) => {
    const fail = (error) => {
      try { log({ service: "output-probe", event: "request_failed", errorName: error?.name ?? "Error", message: String(error?.message ?? "").slice(0, 200) }); } catch { /* logging must not mask the response */ }
      if (response.headersSent || response.writableEnded) { response.destroy(); return; }
      try { json(response, 500, { error: "internal_error" }); } catch { response.destroy(); }
    };
    try {
      const result = handler(request, response);
      if (result && typeof result.then === "function") result.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  };
}

function defaultLog(entry) { process.stderr.write(`${JSON.stringify(entry)}\n`); }
