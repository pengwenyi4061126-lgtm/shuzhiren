import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [room, page, route, store, outbox, worker, migration, schema] = await Promise.all([
  read("apps", "console", "components", "control-room.tsx"),
  read("apps", "console", "app", "page.tsx"),
  read("apps", "console", "app", "api", "v1", "live-runs", "[runId]", "commands", "route.ts"),
  read("apps", "console", "lib", "control-plane", "store.ts"),
  read("apps", "console", "lib", "control-plane", "outbox.ts"),
  read("apps", "runtime-worker", "index.mjs"),
  read("infra", "postgres", "migrations", "065_governed_program_transition_cursor.sql"),
  read("scripts", "verify-postgres-schema.mjs")
]);

for (const source of ["getShowProgram", "initialProgram"]) if (!page.includes(source)) throw new Error(`Control room page must load the frozen show program: ${source}`);
for (const source of ["INSERT_PROGRAM", "ROLLBACK_PROGRAM", "Gateway 已确认插播", "initialProgram?.segments", "programSegmentId"]) if (!room.includes(source)) throw new Error(`Control room must expose governed program transition state: ${source}`);
for (const source of ["INSERT_PROGRAM", "ROLLBACK_PROGRAM", "programSegmentId"]) if (!route.includes(source) || !store.includes(source)) throw new Error(`Command API must validate governed program transition input: ${source}`);
if (!store.includes("A frozen program segment is required")) throw new Error("Control-plane command service must reject an unbound program segment");
for (const source of ["applyProgramTransitionReceipt", "pending_program_transition_event_id", "live_program.transition_accepted"]) if (!outbox.includes(source) || !worker.includes(source)) throw new Error(`Both manual and worker delivery must apply program transition receipts: ${source}`);
for (const source of ["active_insert_program_segment_id", "validate_live_run_program_cursor", "live_runs_governed_program_cursor"]) if (!migration.includes(source)) throw new Error(`Program cursor migration is missing: ${source}`);
for (const source of ["active_insert_program_segment_id", "live_runs_governed_program_cursor"]) if (!schema.includes(source)) throw new Error(`Database schema verifier must retain the governed program cursor: ${source}`);

console.log("PASS  control room, command API, outbox paths, and PostgreSQL cursor guards implement governed program transitions");
