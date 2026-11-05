import type { PoolClient } from "pg";
import type { RequestContext } from "@/lib/control-plane/auth-context";
import { databasePool, withTenantTransaction } from "@/lib/database";

export async function assertLiveRunAccess(context: RequestContext, runId: string) {
  if (!isUuid(runId)) throw new Response("Live run not found", { status: 404 });
  if (!databasePool()) return;
  const accessible = await withTenantTransaction(context.tenantId, async (client) => liveRunAccessible(client, context, runId));
  if (!accessible) throw new Response("Live run not found", { status: 404 });
}

// Same check on a caller's transaction client, so callers that already hold a
// connection do not take a second one from the pool.
export async function assertLiveRunAccessInTransaction(client: PoolClient, context: RequestContext, runId: string) {
  if (!isUuid(runId) || !(await liveRunAccessible(client, context, runId))) throw new Response("Live run not found", { status: 404 });
}

async function liveRunAccessible(client: PoolClient, context: RequestContext, runId: string) {
  const restricted = hasRestrictedMembership(context);
  const result = await client.query<{ id: string }>(
    restricted
      ? `select r.id from live_runs r
         where r.id = $1::uuid and exists (
           select 1 from membership_resource_scopes scope
           where scope.membership_id = $2::uuid
             and ((scope.resource_type = 'live_run' and scope.resource_id = r.id)
               or (scope.resource_type = 'channel_connection' and scope.resource_id = r.channel_connection_id))
         )`
      : "select id from live_runs where id = $1::uuid",
    restricted ? [runId, context.membershipId] : [runId]
  );
  return Boolean(result.rows[0]);
}

export function hasRestrictedMembership(context: RequestContext) {
  return context.accessScope === "restricted" && Boolean(context.membershipId);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
