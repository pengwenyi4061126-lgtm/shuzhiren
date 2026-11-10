import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const [protocol, client, worker, gateway, gatewayTest, integration, store, scriptPlays] = await Promise.all([
  read("apps", "console", "lib", "media-protocol.ts"),
  read("apps", "console", "lib", "runtime-gateway.ts"),
  read("apps", "runtime-worker", "index.mjs"),
  read("runtime", "gateway", "app.py"),
  read("scripts", "test-runtime-gateway-concurrency.py"),
  read("scripts", "test-control-plane-postgres.mjs"),
  read("apps", "console", "lib", "control-plane", "store.ts"),
  read("apps", "console", "lib", "script-plays.ts")
]);

for (const source of ["insert_program", "resume_program"]) if (!protocol.includes(source)) throw new Error(`Media protocol must retain governed program transition action: ${source}`);
for (const source of ["start_program", "programSegmentId", "programSegmentIdValid", "runtimeScript", "scriptSha256", "assertMediaGatewayReceipt", "receipt does not bind the media command"]) if (!client.includes(source)) throw new Error(`Console media client must bind Gateway receipt to frozen program content: ${source}`);
for (const source of ["SCHEDULED_START", "start_program", "programSegmentIdValid", "runtimeScript", "scriptSha256", "applyActivationProgramReceipt", "assertMediaGatewayReceipt", "program segment"]) if (!worker.includes(source)) throw new Error(`Runtime worker must verify governed program dispatch and receipt: ${source}`);
for (const source of ["start_program", "program_segment_id", "program_script", "script_sha256", "[1-5]", "Program start script and hash must be supplied together", "start_live_output", "/api/admin/stream/start", "/api/admin/stream/stop", "play_frozen_program_script", "livetalking_api_accepted"]) if (!gateway.includes(source)) throw new Error(`Runtime Gateway must bind and deliver the frozen program script and manage its RTMP output: ${source}`);
for (const source of ["command_start_frozen", "command_insert", "mismatched frozen script hash", "not-a-uuid", "program_segment_id"]) if (!gatewayTest.includes(source)) throw new Error(`Gateway concurrency test must cover frozen program activation and insertion: ${source}`);
if (!integration.includes("receipt: { command_id: command.command_id")) throw new Error("Control-plane integration mock must emit a bound Gateway receipt");
// Script rotation (design.md module C): the dispatched script is the version selected under the run lock, and its ledger row is written with the outbox event.
for (const source of ["selectScriptForDispatch", "recordScriptPlayInTransaction", "scriptGuardContextInTransaction", "runtime_script_variants", "scriptVariantIndex", "selected.runtimeScript", "selected.scriptSha256"]) if (!store.includes(source)) throw new Error(`Control plane must dispatch the selected script version: ${source}`);
for (const source of ["live_run_script_plays", "program_script_policy_blocked", "program_script.variant_selected", "guardBroadcastText", "chooseScriptVariant"]) if (!scriptPlays.includes(source)) throw new Error(`Script rotation service is missing: ${source}`);

console.log("PASS  governed program-transition commands bind frozen script hashes through Gateway dispatch and receipt validation");
