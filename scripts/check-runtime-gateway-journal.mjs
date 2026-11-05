import { readFile } from "node:fs/promises";

const [gateway, gatewayDockerfile, compose, gatewayEnv, hostPreflight] = await Promise.all([
  readFile(new URL("../runtime/gateway/app.py", import.meta.url), "utf8"),
  readFile(new URL("../runtime/gateway/Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.runtime.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/runtime-gateway.example.env", import.meta.url), "utf8"),
  readFile(new URL("../scripts/check-runtime-host.sh", import.meta.url), "utf8")
]);

for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH", "reserve_runtime_command", "Runtime command outcome is uncertain", "validate_runtime_configuration", "RUNTIME_SHARED_TOKEN must contain at least 32 non-whitespace characters", "os.umask(0o027)",
  // Requirement 19: four-state journal enforced by SQLite, startup recovery, and the operator routes.
  "state in ('reserved', 'completed', 'failed_definite', 'uncertain')", "runtime_command_journal_transition", "runtime_command_journal_retain_open", "recover_interrupted_commands", "command_outcome_uncertain", "command_failed_definite", '"/v1/ops/uncertain-commands"', '"/v1/ops/uncertain-commands/{command_id}/resolution"']) {
  if (!gateway.includes(source)) throw new Error(`Runtime Gateway must retain durable command journal behavior: ${source}`);
}
for (const source of ["USER gateway", "COPY --chown=gateway:shuzhiren app.py audio.py ."]) {
  if (!gatewayDockerfile.includes(source)) throw new Error(`Runtime Gateway image must retain non-root execution: ${source}`);
}
for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH: /var/lib/shuzhiren-runtime/commands.sqlite3", 'RUNTIME_COMMAND_JOURNAL_REQUIRED: "true"', '"${RUNTIME_GATEWAY_HOST_BIND:-127.0.0.1}:8090:8090"', "${RUNTIME_GATEWAY_STATE_PATH:?set-in-runtime-gateway-env}:/var/lib/shuzhiren-runtime"]) {
  if (!compose.includes(source)) throw new Error(`Runtime Compose must retain durable Gateway command journal storage: ${source}`);
}
for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH=/var/lib/shuzhiren-runtime/commands.sqlite3", "RUNTIME_COMMAND_JOURNAL_REQUIRED=true", "RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state", "RUNTIME_GATEWAY_HOST_BIND=127.0.0.1"]) {
  if (!gatewayEnv.includes(source)) throw new Error(`Gateway environment template must document durable command journal configuration: ${source}`);
}
for (const source of ["--require-gateway-state-permissions", "GATEWAY_BACKUP_GROUP", "expected_state_metadata=\"${gateway_uid}:${backup_group_gid}:2750\""]) {
  if (!hostPreflight.includes(source)) throw new Error(`Host preflight must enforce Gateway journal backup permissions: ${source}`);
}

console.log("PASS  Runtime Gateway command journal is durable and required in production Compose");
