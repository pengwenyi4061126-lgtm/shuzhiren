// M14 (Requirement 29, migration 076): memberships_protect_last_admin, which now serializes removals of a
// tenant's active admins through membership_admin_guards, and memberships_guard_access_scope (057).
const LAST_ADMIN = "memberships_protect_last_admin";
const LAST_ADMIN_MESSAGE = "cannot remove the last active tenant admin";
const memberRow = (_ctx, a) => ({ sql: "select user_id, role::text as role, status, access_scope::text as access_scope, suspended_at is not null as suspended from memberships where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] });

async function admins({ seed }, count) {
  const tenantId = await seed.tenant();
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push(await seed.member({ tenantId, role: "admin" }));
  return { tenantId, targetId: ids[0], otherIds: ids.slice(1) };
}

export default [
  {
    id: "memberships.protect_last_admin.update.demote_one_of_two.accept",
    table: "memberships", trigger: LAST_ADMIN, op: "UPDATE", updatedColumns: ["role"], expect: "accept",
    arrange: (ctx) => admins(ctx, 2),
    act: (_ctx, a) => ({ sql: "update memberships set role = 'operator' where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow,
    expectedAfter: (a) => [{ user_id: a.targetId, role: "operator", status: "active" }]
  },
  {
    id: "memberships.protect_last_admin.update.suspend_one_of_two.accept",
    table: "memberships", trigger: LAST_ADMIN, op: "UPDATE", updatedColumns: ["status"], expect: "accept",
    arrange: (ctx) => admins(ctx, 2),
    act: (_ctx, a) => ({ sql: "update memberships set status = 'suspended' where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow,
    expectedAfter: (a) => [{ user_id: a.targetId, role: "admin", status: "suspended", suspended: true }]
  },
  {
    id: "memberships.protect_last_admin.update.demote_last.reject",
    table: "memberships", trigger: LAST_ADMIN, op: "UPDATE", updatedColumns: ["role"], expect: "reject", message: LAST_ADMIN_MESSAGE,
    arrange: (ctx) => admins(ctx, 1),
    act: (_ctx, a) => ({ sql: "update memberships set role = 'operator' where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow
  },
  {
    id: "memberships.protect_last_admin.delete.last.reject",
    table: "memberships", trigger: LAST_ADMIN, op: "DELETE", expect: "reject", message: LAST_ADMIN_MESSAGE,
    arrange: (ctx) => admins(ctx, 1),
    act: (_ctx, a) => ({ sql: "delete from memberships where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow
  },
  {
    id: "memberships.protect_last_admin.delete.one_of_two.accept",
    table: "memberships", trigger: LAST_ADMIN, op: "DELETE", expect: "accept",
    arrange: (ctx) => admins(ctx, 2),
    act: (_ctx, a) => ({ sql: "delete from memberships where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow,
    expectedAfter: () => []
  },
  {
    id: "memberships.guard_access_scope.insert.restricted_admin.reject",
    table: "memberships", trigger: "memberships_guard_access_scope", op: "INSERT", expect: "reject",
    message: "tenant administrators must retain tenant-wide access",
    async arrange({ client, seed }) {
      const tenantId = await seed.tenant();
      const user = await client.query("insert into users (external_subject, display_name) values ('it-m14-' || gen_random_uuid(), 'M14 restricted admin') returning id");
      return { tenantId, targetId: user.rows[0].id };
    },
    act: (_ctx, a) => ({ sql: "insert into memberships (tenant_id, user_id, role, access_scope) values ($1, $2, 'admin', 'restricted')", params: [a.tenantId, a.targetId] }),
    readBack: memberRow
  },
  {
    id: "memberships.guard_access_scope.update.operator_restricted.accept",
    table: "memberships", trigger: "memberships_guard_access_scope", op: "UPDATE", updatedColumns: ["access_scope"], expect: "accept",
    async arrange({ seed }) {
      const tenantId = await seed.tenant();
      await seed.member({ tenantId, role: "admin" });
      return { tenantId, targetId: await seed.member({ tenantId, role: "operator" }) };
    },
    act: (_ctx, a) => ({ sql: "update memberships set access_scope = 'restricted' where tenant_id = $1 and user_id = $2", params: [a.tenantId, a.targetId] }),
    readBack: memberRow,
    expectedAfter: (a) => [{ user_id: a.targetId, role: "operator", access_scope: "restricted" }]
  }
];
