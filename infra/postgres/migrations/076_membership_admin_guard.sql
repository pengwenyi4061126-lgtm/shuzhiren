-- M14: protect_last_active_tenant_admin() (054) checks "another active admin exists" with a plain read. Two
-- concurrent transactions that each remove a different admin both see the other admin still active, both pass,
-- and the tenant is left without an active admin (write skew).
--
-- Removing an active admin now first writes the tenant's row in membership_admin_guards, then checks. The write
-- serializes the removals of one tenant: under READ COMMITTED the second transaction waits for the first to
-- commit and its check (a new statement, so a new snapshot) sees the first removal and fails; under REPEATABLE
-- READ and SERIALIZABLE its guard write fails with 40001 because a concurrent transaction changed the row. A
-- plain row lock would not be enough there, since the check would still read the old snapshot. Membership
-- changes that do not remove an active admin do not touch the guard.
create table if not exists membership_admin_guards (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table membership_admin_guards enable row level security;
alter table membership_admin_guards force row level security;
drop policy if exists tenant_isolation_membership_admin_guards on membership_admin_guards;
create policy tenant_isolation_membership_admin_guards on membership_admin_guards
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));
revoke all on membership_admin_guards from public;

-- SECURITY DEFINER so that application roles need no privilege on membership_admin_guards. Row-level security
-- still applies to the owner (FORCE), so the guard row written is the one of the caller's app.tenant_id, which
-- is also the only tenant whose memberships the caller can change.
create or replace function protect_last_active_tenant_admin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  removes_active_admin boolean := false;
begin
  if old.role = 'admin' and old.status = 'active' then
    if TG_OP = 'DELETE' then
      removes_active_admin := true;
    else
      removes_active_admin := new.role <> 'admin' or new.status <> 'active';
    end if;
  end if;

  if removes_active_admin then
    insert into public.membership_admin_guards as guard (tenant_id)
    values (old.tenant_id)
    on conflict (tenant_id) do update set revision = guard.revision + 1, updated_at = now();
    if not exists (
      select 1 from public.memberships
      where tenant_id = old.tenant_id and status = 'active' and role = 'admin' and id <> old.id
    ) then
      raise exception 'cannot remove the last active tenant admin';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  if new.status = 'suspended' and old.status <> 'suspended' then new.suspended_at := now(); end if;
  if new.status = 'revoked' and old.status <> 'revoked' then new.revoked_at := now(); end if;
  if new.status = 'active' then new.suspended_at := null; new.revoked_at := null; end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function protect_last_active_tenant_admin() from public;
-- The memberships_protect_last_admin trigger from 054 keeps pointing at this function.
