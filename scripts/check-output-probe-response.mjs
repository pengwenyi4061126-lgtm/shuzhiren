import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/output-probe/index.mjs", import.meta.url), "utf8");

for (const expected of ["event: \"measurement_failed\"", 'return json(response, 503, { error: "measurement_unavailable" });']) {
  if (!source.includes(expected)) throw new Error(`Output probe must retain sanitized measurement failures: ${expected}`);
}
if (source.includes('error: "measurement_unavailable", detail:')) throw new Error("Output probe must not return backend measurement diagnostics to callers");

console.log("PASS  output probe keeps measurement diagnostics out of HTTP responses");
