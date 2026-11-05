import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, attestationMigration, store, route, observer, probe, timeline, page, monitoring, schema, integration] = await Promise.all([
  read("infra", "postgres", "migrations", "066_program_output_observations.sql"),
  read("infra", "postgres", "migrations", "067_program_output_attestation_trust.sql"),
  read("apps", "console", "lib", "program-output-observations.ts"),
  read("apps", "console", "app", "api", "v1", "runtime", "program-output-observations", "route.ts"),
  read("apps", "runtime-observer", "index.mjs"),
  read("apps", "output-probe", "lib.mjs"),
  read("apps", "console", "lib", "run-events.ts"),
  read("apps", "console", "app", "shows", "[runId]", "events", "page.tsx"),
  read("apps", "console", "app", "monitoring", "page.tsx"),
  read("scripts", "verify-postgres-schema.mjs"),
  read("scripts", "test-control-plane-postgres.mjs")
]);

for (const source of ["program_output_observations", "program_output_observations_append_only", "govern_program_output_observation", "event.state = 'delivered'", "program output observations are immutable", "program output observation must bind this tenant run, session, and frozen program segment"]) if (!migration.includes(source)) throw new Error(`Output observation migration must retain ${source}`);
for (const source of ["verifier_issuer", "attestation_sha256", "15 minutes", "10 minutes", "accepted real-time command window"]) if (!attestationMigration.includes(source)) throw new Error(`Output observation attestation migration must retain ${source}`);
for (const source of ["recordProgramOutputObservation", "listProgramOutputObservations", "verifyProgramOutputAttestation", "canonicalProgramOutputAttestationPayload", "live_program.output_observed", "Output observation does not match a delivered governed media command", "sameObservation"]) if (!store.includes(source)) throw new Error(`Output observation store must retain ${source}`);
for (const source of ["requireProgramOutputObservationService", "verifyProgramOutputAttestation", "isProgramOutputObservationInput", "recordProgramOutputObservation"]) if (!route.includes(source)) throw new Error(`Output observation endpoint must retain ${source}`);
for (const source of ["postProgramOutputObservation", "programOutputToken", "validProgramObservation", "program_output_observation.rejected"]) if (!observer.includes(source)) throw new Error(`Runtime observer must forward only valid output evidence: ${source}`);
for (const source of ["programEvidenceUrl", "fetchProgramEvidence", "validateProgramObservation", "Output health must remain available"]) if (!probe.includes(source)) throw new Error(`Output probe must keep optional verifier evidence isolated from health: ${source}`);
for (const source of ["listProgramOutputObservations", "category: \"output\"", "state: \"observed\""]) if (!timeline.includes(source)) throw new Error(`Run timeline must expose output evidence: ${source}`);
if (!page.includes("output: RadioTower")) throw new Error("Run event page must render output observations");
for (const source of ["listProgramOutputObservations", "节目输出证据", "尚未收到独立输出验证器证明"]) if (!monitoring.includes(source)) throw new Error(`Monitoring page must surface output evidence: ${source}`);
for (const source of ["program_output_observations", "program_output_observations_run_observed_idx", "tenant_isolation_program_output_observations"]) if (!schema.includes(source)) throw new Error(`Schema verification must cover ${source}`);
for (const source of ["program-output-observations", "live_program.output_observed", "program output observation"]) if (!integration.includes(source)) throw new Error(`PostgreSQL integration test must cover ${source}`);

console.log("PASS  governed output observations require independent evidence, immutable command linkage, and timeline visibility");

// Canonical_JSON (attestation payloads and release manifest snapshots) must not
// depend on the process locale. Loaded from the console sources.
const { default: assert } = await import("node:assert/strict");
const { register } = await import("node:module");
register("./lib/console-ts-loader.mjs", import.meta.url);
const canonical = await import("../apps/console/lib/canonical-json.mjs");
const releaseManifest = await import("../apps/console/lib/release-manifest.ts");
const observations = await import("../apps/console/lib/program-output-observations.ts");
const { createHash } = await import("node:crypto");
const mixedKeys = { b: 1, B: 2, a: 3, _: 4, Z: 5, "\u00e9": 6, "\u{1f600}": 7, "\uff5e": 8, ab: 9, a_b: 10 };
const codePointOrder = ["B", "Z", "_", "a", "a_b", "ab", "b", "\u00e9", "\uff5e", "\u{1f600}"];
const originalLocaleCompare = String.prototype.localeCompare;
const OriginalCollator = Intl.Collator;
String.prototype.localeCompare = () => { throw new Error("Canonical_JSON v2 must not call localeCompare"); };
Intl.Collator = function Collator() { throw new Error("Canonical_JSON v2 must not use Intl.Collator"); };
let encoded;
try {
  encoded = canonical.canonicalJson({ nested: mixedKeys, list: [mixedKeys, undefined, null, 1.5e-7, -0, "\u2028"], skipped: undefined });
} finally {
  String.prototype.localeCompare = originalLocaleCompare;
  Intl.Collator = OriginalCollator;
}
assert.deepEqual(Object.keys(JSON.parse(encoded).nested), codePointOrder, "Canonical_JSON v2 must sort keys by code point");
assert.equal(encoded.startsWith('{"list":['), true, "top-level keys must be sorted by code point");
assert.ok(!encoded.includes("skipped"), "undefined members must be dropped");
assert.match(encoded, /,null,null,1\.5e-7,0,/, "undefined array elements must become null and numbers must use Number::toString");
for (const [label, value] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["bigint", 1n], ["Date", new Date(0)], ["Map", new Map()], ["function", () => 1], ["symbol", Symbol("x")]]) {
  assert.throws(() => canonical.canonicalJson({ value: value }), (error) => error instanceof canonical.CanonicalJsonError && error.path === "$.value", `Canonical_JSON v2 must reject ${label} with its path`);
}
for (const [left, right] of [["a", "b"], ["B", "a"], ["Z", "_"], ["a", "ab"], ["\uff5e", "\u{1f600}"], ["\u{1f600}", "\u{1f601}"]]) {
  assert.equal(canonical.compareCodePoints(left, right), -1, `${JSON.stringify(left)} must sort before ${JSON.stringify(right)}`);
  assert.equal(canonical.compareCodePoints(right, left), 1);
}
assert.equal(canonical.compareCodePoints("same", "same"), 0);

// Release manifest snapshots sealed with either rule verify; altered content does not.
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const snapshotContent = { runId: "run", facts: mixedKeys, models: [{ id: "m", component: "voice" }] };
for (const ruleVersion of [1, 2]) {
  const sealed = sha256(canonical.canonicalJson(snapshotContent, { ruleVersion }));
  assert.equal(releaseManifest.releaseManifestSnapshotMatches({ ...snapshotContent, sha256: sealed }, sealed), true, `a snapshot sealed with rule ${ruleVersion} must verify`);
  assert.equal(releaseManifest.releaseManifestSnapshotMatches({ ...snapshotContent, runId: "other", sha256: sealed }, sealed), false, `an altered snapshot sealed with rule ${ruleVersion} must not verify`);
  assert.equal(releaseManifest.releaseManifestSnapshotMatches({ ...snapshotContent, sha256: "0".repeat(64) }, sealed), false, "a snapshot whose embedded hash differs must not verify");
}

// The attestation payload uses the code-point rule.
const observationInput = { runId: "r", outboxEventId: "o", runtimeSessionId: "s", commandId: "c", programSegmentId: "p", action: "START", source: "watermark", evidenceRef: "evidence://x", contentSha256: "a".repeat(64), confidence: 0.99, mediaTimeMs: 1, observedAt: "2026-11-05T00:00:00.000Z", attestation: { issuer: "watermark_verifier", keyId: "k", audience: "t:r", issuedAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T00:05:00.000Z", signature: "" } };
const attestationPayload = observations.canonicalProgramOutputAttestationPayload(observationInput);
assert.equal(attestationPayload, canonical.canonicalJson(JSON.parse(attestationPayload)), "attestation payloads must be Canonical_JSON v2");
console.log("PASS  Canonical_JSON sorts keys by code point without locale APIs, rejects non-JSON values, and still verifies legacy snapshots");
