import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/output-probe/handler.mjs", import.meta.url), "utf8");

for (const expected of ["event: \"measurement_failed\"", 'return json(response, 503, { error: "measurement_unavailable" });']) {
  if (!source.includes(expected)) throw new Error(`Output probe must retain sanitized measurement failures: ${expected}`);
}
if (source.includes('error: "measurement_unavailable", detail:')) throw new Error("Output probe must not return backend measurement diagnostics to callers");

console.log("PASS  output probe keeps measurement diagnostics out of HTTP responses");

// M8: the text checks above only prove the strings exist. Run the handler: a failing measurement must answer
// exactly { error: "measurement_unavailable" } with 503, log the diagnostic as measurement_failed, and keep the
// diagnostic out of the response body.
const { createProbeHandler } = await import("../apps/output-probe/handler.mjs");
const diagnostic = "ffprobe rtmp://ingest.internal/live/secret-stream-key: connection refused";
const logged = [];
const handler = createProbeHandler({ token: "probe-token", targets: new Map([["program", { id: "program" }]]), measure: async () => { throw new Error(diagnostic); }, log: (entry) => logged.push(entry) });
const response = { status: 0, headers: {}, body: "", writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = String(body ?? ""); } };
await handler({ method: "GET", url: "/v1/probes/program", headers: { authorization: "Bearer probe-token" } }, response);
if (response.status !== 503 || response.body !== JSON.stringify({ error: "measurement_unavailable" })) throw new Error(`Output probe must answer a failed measurement with 503 measurement_unavailable only, got ${response.status} ${response.body}`);
if (response.body.includes("secret-stream-key")) throw new Error("Output probe must not return backend measurement diagnostics to callers");
if (!logged.some((entry) => entry.event === "measurement_failed" && entry.diagnostic === diagnostic)) throw new Error("Output probe must log the measurement diagnostic as measurement_failed");
console.log("PASS  a failed output probe measurement answers 503 measurement_unavailable and only logs the diagnostic");
