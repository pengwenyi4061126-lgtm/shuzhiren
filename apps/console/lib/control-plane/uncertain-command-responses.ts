import { RuntimeGatewayError } from "@/lib/runtime-gateway";

// Gateway answers an operator can act on keep their status and code; anything else (an unreachable Gateway, a
// rejected token, an invalid answer) becomes 503 runtime_unavailable and its cause goes to the service log only.
const operatorFacingCodes = new Set(["command_not_found", "command_not_uncertain", "command_identity_unavailable", "request_invalid"]);
export function uncertainCommandGatewayFailure(error: unknown, route: string) {
  if (error instanceof RuntimeGatewayError && error.code && operatorFacingCodes.has(error.code) && [404, 409, 422].includes(error.status)) {
    return Response.json({ error: error.code, code: error.code }, { status: error.status });
  }
  console.error(JSON.stringify({ service: "control-plane", event: "runtime_uncertain_commands_unavailable", route, status: error instanceof RuntimeGatewayError ? error.status : null, error: redactSecret(error instanceof Error ? error.message : String(error), process.env.RUNTIME_SHARED_TOKEN) }));
  return Response.json({ error: "runtime_unavailable" }, { status: 503 });
}
function redactSecret(message: string, secret: string | undefined) {
  return secret ? message.split(secret).join("[redacted]") : message;
}
