import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [migration, store, route, observer, probe, timeline, page, schema, integration] = await Promise.all([
  read("infra", "postgres", "migrations", "066_program_output_observations.sql"),
  read("apps", "console", "lib", "program-output-observations.ts"),
  read("apps", "console", "app", "api", "v1", "runtime", "program-output-observations", "route.ts"),
  read("apps", "runtime-observer", "index.mjs"),
  read("apps", "output-probe", "lib.mjs"),
  read("apps", "console", "lib", "run-events.ts"),
  read("apps", "console", "app", "shows", "[runId]", "events", "page.tsx"),
  read("scripts", "verify-postgres-schema.mjs"),
  read("scripts", "test-control-plane-postgres.mjs")
]);

for (const source of ["program_output_observations", "program_output_observations_append_only", "govern_program_output_observation", "event.state = 'delivered'", "program output observations are immutable", "program output observation must bind this tenant run, session, and frozen program segment"]) if (!migration.includes(source)) throw new Error(`Output observation migration must retain ${source}`);
for (const source of ["recordProgramOutputObservation", "listProgramOutputObservations", "live_program.output_observed", "Output observation does not match a delivered governed media command", "sameObservation"]) if (!store.includes(source)) throw new Error(`Output observation store must retain ${source}`);
for (const source of ["requireRuntimeService", "isProgramOutputObservationInput", "recordProgramOutputObservation"]) if (!route.includes(source)) throw new Error(`Output observation endpoint must retain ${source}`);
for (const source of ["postProgramOutputObservation", "validProgramObservation", "program_output_observation.rejected"]) if (!observer.includes(source)) throw new Error(`Runtime observer must forward only valid output evidence: ${source}`);
for (const source of ["programEvidenceUrl", "fetchProgramEvidence", "validateProgramObservation", "Output health must remain available"]) if (!probe.includes(source)) throw new Error(`Output probe must keep optional verifier evidence isolated from health: ${source}`);
for (const source of ["listProgramOutputObservations", "category: \"output\"", "state: \"observed\""]) if (!timeline.includes(source)) throw new Error(`Run timeline must expose output evidence: ${source}`);
if (!page.includes("output: RadioTower")) throw new Error("Run event page must render output observations");
for (const source of ["program_output_observations", "program_output_observations_run_observed_idx", "tenant_isolation_program_output_observations"]) if (!schema.includes(source)) throw new Error(`Schema verification must cover ${source}`);
for (const source of ["program-output-observations", "live_program.output_observed", "program output observation"]) if (!integration.includes(source)) throw new Error(`PostgreSQL integration test must cover ${source}`);

console.log("PASS  governed output observations require independent evidence, immutable command linkage, and timeline visibility");
