import type { PoolClient } from "pg";
import { recordAuditEventInTransaction } from "@/lib/audit";
import type { ActorRole, MembershipAccessScope, RequestContext } from "@/lib/control-plane/auth-context";
import { withTenantTransaction } from "@/lib/database";

export type MembershipStatus = "active" | "suspended" | "revoked";
export type MembershipResourceType = "channel_connection" | "live_run";
export type MembershipResourceScope = { resourceType: MembershipResourceType; resourceId: string };
export type TenantMembership = {
  id: string;
  tenantId: string;
  externalSubject: string;
  displayName: string;
  role: ActorRole;
  status: MembershipStatus;
  accessScope: MembershipAccessScope;
  resourceScopes: MembershipResourceScope[];
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
};

export type CreateMembershipInput = { externalSubject: string; displayName: string; role: ActorRole };
export type UpdateMembershipInput = { role?: ActorRole; status?: MembershipStatus; accessScope?: MembershipAccessScope; resourceScopes?: MembershipResourceScope[] };

type MembershipRow = {
  id: string;
  tenant_id: string;
  external_subject: string;
  display_name: string;
  role: ActorRole;
  status: MembershipStatus;
  access_scope: MembershipAccessScope;
  created_at: Date | string;
  updated_at: Date | string;
  suspended_at: Date | string | null;
  revoked_at: Date | string | null;
  user_id: string;
};

const columns = `m.id, m.tenant_id, m.user_id, u.external_subject, u.display_name, m.role, m.status,
  m.access_scope, m.created_at, m.updated_at, m.suspended_at, m.revoked_at`;

export async function listMemberships(context: RequestContext): Promise<TenantMembership[]> {
  return withTenantTransaction(context.tenantId, async (client) => {
    const result = await client.query<MembershipRow>(
      `select ${columns} from memberships m join users u on u.id = m.user_id order by u.display_name, u.external_subject`
    );
    return attachResourceScopes(client, result.rows);
  });
}

export async function createMembership(context: RequestContext, input: CreateMembershipInput): Promise<TenantMembership> {
  return withTenantTransaction(context.tenantId, async (client) => {
    const actorId = await actorDatabaseId(client, context);
    const user = await client.query<{ id: string }>(
      `insert into users (external_subject, display_name) values ($1, $2)
       on conflict (external_subject) do update set display_name = excluded.display_name
       returning id`,
      [input.externalSubject, input.displayName]
    );
    const created = await client.query<MembershipRow>(
      `insert into memberships (tenant_id, user_id, role) values ($1::uuid, $2::uuid, $3::membership_role)
       on conflict (tenant_id, user_id) do nothing
       returning id, tenant_id, user_id, $4::text as external_subject, $5::text as display_name, role, status,
         access_scope, created_at, updated_at, suspended_at, revoked_at`,
      [context.tenantId, user.rows[0].id, input.role, input.externalSubject, input.displayName]
    );
    const membership = created.rows[0];
    if (!membership) throw new Response("Membership already exists", { status: 409 });
    await recordAuditEventInTransaction(client, context, {
      type: "membership.provisioned",
      resource: "membership",
      resourceId: membership.id,
      detail: { externalSubject: input.externalSubject, role: input.role, status: "active", actorDatabaseId: actorId }
    });
    return persistentMembership(membership, []);
  });
}

export async function updateMembership(context: RequestContext, membershipId: string, input: UpdateMembershipInput): Promise<TenantMembership> {
  return withTenantTransaction(context.tenantId, async (client) => {
    const existing = await client.query<MembershipRow>(
      `select ${columns} from memberships m join users u on u.id = m.user_id where m.id = $1::uuid for update`,
      [membershipId]
    );
    const current = existing.rows[0];
    if (!current) throw new Response("Membership not found", { status: 404 });
    const actorId = await actorDatabaseId(client, context);
    if (actorId === current.user_id) throw new Response("Administrators cannot change their own membership", { status: 409 });
    const nextRole = input.role ?? current.role;
    const nextAccessScope = nextRole === "admin" ? "tenant" : input.accessScope ?? current.access_scope;
    if (nextRole === "admin" && input.accessScope === "restricted") throw new Response("Tenant administrators must retain tenant-wide access", { status: 409 });
    const updated = await client.query<MembershipRow>(
      `update memberships set role = $2::membership_role, status = coalesce($3, status), access_scope = $4::membership_access_scope
       where id = $1::uuid
       returning id, tenant_id, user_id, $5::text as external_subject, $6::text as display_name, role, status,
         access_scope, created_at, updated_at, suspended_at, revoked_at`,
      [membershipId, nextRole, input.status ?? null, nextAccessScope, current.external_subject, current.display_name]
    );
    const membership = updated.rows[0];
    let resourceScopes: MembershipResourceScope[] = (await listResourceScopes(client, membership.id)).map(({ resourceType, resourceId }) => ({ resourceType, resourceId }));
    if (nextAccessScope === "tenant") {
      await client.query("delete from membership_resource_scopes where membership_id = $1::uuid", [membership.id]);
      resourceScopes = [];
    } else if (input.resourceScopes) {
      await replaceResourceScopes(client, context.tenantId, membership.id, input.resourceScopes);
      resourceScopes = input.resourceScopes;
    }
    await recordAuditEventInTransaction(client, context, {
      type: "membership.updated",
      resource: "membership",
      resourceId: membership.id,
      detail: {
        externalSubject: membership.external_subject,
        previousRole: current.role,
        role: membership.role,
        previousStatus: current.status,
        status: membership.status,
        previousAccessScope: current.access_scope,
        accessScope: membership.access_scope,
        resourceScopeCount: resourceScopes.length
      }
    });
    return persistentMembership(membership, resourceScopes);
  });
}

async function actorDatabaseId(client: PoolClient, context: RequestContext) {
  const actor = await client.query<{ id: string }>(
    "select sync_control_plane_actor($1::uuid, $2, $3, $4::membership_role) as id",
    [context.tenantId, context.actorId, context.actorName, context.role]
  );
  return actor.rows[0].id;
}

async function attachResourceScopes(client: PoolClient, memberships: MembershipRow[]) {
  const scopes = await listResourceScopes(client, memberships.map((membership) => membership.id));
  const byMembership = new Map<string, MembershipResourceScope[]>();
  for (const scope of scopes) byMembership.set(scope.membershipId, [...(byMembership.get(scope.membershipId) ?? []), { resourceType: scope.resourceType, resourceId: scope.resourceId }]);
  return memberships.map((membership) => persistentMembership(membership, byMembership.get(membership.id) ?? []));
}

type PersistentResourceScopeRow = { membership_id: string; resource_type: MembershipResourceType; resource_id: string };

async function listResourceScopes(client: PoolClient, membershipIds: string | string[]) {
  const ids = Array.isArray(membershipIds) ? membershipIds : [membershipIds];
  if (!ids.length) return [] as Array<MembershipResourceScope & { membershipId: string }>;
  const result = await client.query<PersistentResourceScopeRow>(
    "select membership_id, resource_type, resource_id from membership_resource_scopes where membership_id = any($1::uuid[]) order by resource_type, resource_id",
    [ids]
  );
  return result.rows.map((row) => ({ membershipId: row.membership_id, resourceType: row.resource_type, resourceId: row.resource_id }));
}

async function replaceResourceScopes(client: PoolClient, tenantId: string, membershipId: string, scopes: MembershipResourceScope[]) {
  const unique = new Map(scopes.map((scope) => [`${scope.resourceType}:${scope.resourceId}`, scope]));
  await client.query("delete from membership_resource_scopes where membership_id = $1::uuid", [membershipId]);
  for (const scope of unique.values()) {
    await client.query(
      "insert into membership_resource_scopes (tenant_id, membership_id, resource_type, resource_id) values ($1::uuid, $2::uuid, $3, $4::uuid)",
      [tenantId, membershipId, scope.resourceType, scope.resourceId]
    );
  }
}

function persistentMembership(row: MembershipRow, resourceScopes: MembershipResourceScope[]): TenantMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalSubject: row.external_subject,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    accessScope: row.access_scope,
    resourceScopes,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null
  };
}
