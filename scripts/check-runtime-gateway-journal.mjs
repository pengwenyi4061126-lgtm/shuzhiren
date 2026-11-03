import { readFile } from "node:fs/promises";

const [gateway, compose, gatewayEnv] = await Promise.all([
  readFile(new URL("../runtime/gateway/app.py", import.meta.url), "utf8"),
  readFile(new URL("../infra/compose/docker-compose.runtime.yml", import.meta.url), "utf8"),
  readFile(new URL("../config/runtime-gateway.example.env", import.meta.url), "utf8")
]);

for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH", "reserve_runtime_command", "Runtime command outcome is uncertain"]) {
  if (!gateway.includes(source)) throw new Error(`Runtime Gateway must retain durable command journal behavior: ${source}`);
}
for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH: /var/lib/shuzhiren-runtime/commands.sqlite3", 'RUNTIME_COMMAND_JOURNAL_REQUIRED: "true"', '"${RUNTIME_GATEWAY_HOST_BIND:-127.0.0.1}:8090:8090"', "${RUNTIME_GATEWAY_STATE_PATH:?set-in-runtime-gateway-env}:/var/lib/shuzhiren-runtime"]) {
  if (!compose.includes(source)) throw new Error(`Runtime Compose must retain durable Gateway command journal storage: ${source}`);
}
for (const source of ["RUNTIME_COMMAND_JOURNAL_PATH=/var/lib/shuzhiren-runtime/commands.sqlite3", "RUNTIME_COMMAND_JOURNAL_REQUIRED=true", "RUNTIME_GATEWAY_STATE_PATH=/srv/shuzhiren/runtime-gateway-state", "RUNTIME_GATEWAY_HOST_BIND=127.0.0.1"]) {
  if (!gatewayEnv.includes(source)) throw new Error(`Gateway environment template must document durable command journal configuration: ${source}`);
}

console.log("PASS  Runtime Gateway command journal is durable and required in production Compose");
