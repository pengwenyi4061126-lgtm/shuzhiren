import { requireRole, requireTenantWideAccess, type RequestContext } from "@/lib/control-plane/auth-context";
import { findRuntimeCommandEvents, type OutboxState } from "@/lib/control-plane/outbox";
import { recordAuditEvent } from "@/lib/audit";
import { listUncertainRuntimeCommands, resolveUncertainRuntimeCommand, runtimeCommandIdValid, type RuntimeCommandResolution, type RuntimeCommandResolutionResult, type UncertainRuntimeCommand } from "@/lib/runtime-gateway";

// H7 (Requirement 19.9-19.11): commands whose outcome the Runtime Gateway could not determine. Listing and
// resolving them goes through the Gateway's operator routes; the console adds the tenant's outbox event so an
// operator can find the live run and redeliver the event after checking the media session.
export type UncertainCommandView = UncertainRuntimeCommand & { outboxEventId: string; runId: string; eventType: "media.dispatch" | "speech.dispatch"; outboxState: OutboxState; outcomeUncertainAt?: string };
export type UncertainCommandResolutionInput = { resolution: RuntimeCommandResolution; note: string };
export type UncertainCommandResolutionView = RuntimeCommandResolutionResult & { outboxEventId: string; runId: string };
export const resolutionNoteMaxChars = 500;

// The Gateway token reaches every tenant's commands, so only a tenant-wide admin may use these routes.
export function requireUncertainCommandOperator(context: RequestContext) {
  requireRole(context, ["admin"]);
  requireTenantWideAccess(context);
}

export function parseResolutionInput(value: unknown): UncertainCommandResolutionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { resolution, note } = value as Record<string, unknown>;
  if (resolution !== "completed" && resolution !== "failed_definite") return null;
  // The same bounds as the Gateway: 1 to 500 characters, not only whitespace.
  if (typeof note !== "string" || !note.trim() || note.length > resolutionNoteMaxChars) return null;
  return { resolution, note };
}

export async function listUncertainCommands(context: RequestContext): Promise<UncertainCommandView[]> {
  requireUncertainCommandOperator(context);
  const commands = await listUncertainRuntimeCommands();
  const events = await findRuntimeCommandEvents(context, commands.map((command) => command.commandId));
  return commands.flatMap((command) => {
    const event = events.get(command.commandId);
    return event ? [{ ...command, outboxEventId: event.id, runId: event.command.runId, eventType: event.type, outboxState: event.state, outcomeUncertainAt: event.outcomeUncertainAt }] : [];
  });
}

// The resolution is a Gateway call and the audit event is a PostgreSQL write, so they cannot share a
// transaction. The audit event is written after the Gateway accepted the resolution. If that write fails, the
// resolution stands (the Gateway's own runtime_command.resolved log line still records it); the caller gets a
// 5xx and the service log names the command so the missing audit event can be reconstructed.
export class ResolutionAuditFailedError extends Error {
  readonly code = "resolution_audit_failed";
  constructor(readonly result: UncertainCommandResolutionView, cause: unknown) { super("The Gateway recorded the resolution but its audit event was not written", { cause }); }
}

export async function resolveUncertainCommand(context: RequestContext, commandId: string, input: UncertainCommandResolutionInput): Promise<UncertainCommandResolutionView> {
  requireUncertainCommandOperator(context);
  if (!runtimeCommandIdValid(commandId)) throw new Response("Runtime command was not found", { status: 404, statusText: "command_not_found" });
  const event = (await findRuntimeCommandEvents(context, [commandId])).get(commandId);
  if (!event) throw new Response("Runtime command was not found", { status: 404, statusText: "command_not_found" });
  const resolved = await resolveUncertainRuntimeCommand(commandId, input.resolution, input.note);
  const result = { ...resolved, outboxEventId: event.id, runId: event.command.runId };
  try {
    await recordAuditEvent(context, {
      type: "runtime_command.resolved",
      resource: "outbox_event",
      resourceId: event.id,
      detail: { runId: result.runId, commandId, eventType: event.type, previousState: resolved.previousState, resolution: resolved.state, resolvedAt: resolved.resolvedAt, note: input.note }
    });
  } catch (error) {
    console.error(JSON.stringify({ service: "control-plane", event: "runtime_command.resolution_audit_failed", commandId, outboxEventId: event.id, runId: result.runId, resolution: resolved.state, resolvedAt: resolved.resolvedAt, actorId: context.actorId, error: error instanceof Error ? error.name : "unknown" }));
    throw new ResolutionAuditFailedError(result, error);
  }
  return result;
}
