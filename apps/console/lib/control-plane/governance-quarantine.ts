import type { PoolClient } from "pg";
import { recordAuditEventInTransaction } from "@/lib/audit";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { enqueueMediaCommandInTransaction } from "@/lib/control-plane/outbox";
import { createMediaCommand } from "@/lib/media-protocol";

type BindingKind = "model_release" | "media_asset";

export async function quarantineLiveRunsForRevocationInTransaction(client: PoolClient, context: RequestContext, bindingKind: BindingKind, bindingId: string, reason: string) {
  const relation = bindingKind === "model_release"
    ? { table: "show_revision_model_releases", column: "model_release_id" }
    : { table: "show_revision_media_assets", column: "media_asset_id" };
  const affected = await client.query<{ id: string; trace_id: string; runtime_session_id: string | null }>(
    `select r.id, r.trace_id, r.runtime_session_id from live_runs r join ${relation.table} binding on binding.show_revision_id = r.show_revision_id where binding.${relation.column} = $1 and r.state = 'LIVE' for update of r`,
    [bindingId]
  );
  for (const run of affected.rows) {
    await client.query("update live_runs set state = 'DEGRADED', updated_at = now() where id = $1 and state = 'LIVE'", [run.id]);
    if (run.runtime_session_id) await enqueueMediaCommandInTransaction(client, context, createMediaCommand({ runId: run.id, traceId: run.trace_id, type: "switch_to_human", payload: { controlAction: "GOVERNANCE_REVOCATION", reasons: `${bindingKind}:${bindingId}` } }), run.runtime_session_id);
    await recordAuditEventInTransaction(client, context, { type: "live_run.governance_quarantined", resource: "live_run", resourceId: run.id, detail: { bindingKind, bindingId, reason, action: "switch_to_human" } });
  }
  return affected.rows.map((run) => run.id);
}
