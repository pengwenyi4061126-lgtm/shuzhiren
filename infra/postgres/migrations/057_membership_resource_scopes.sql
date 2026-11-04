-- A tenant role is necessary but not always sufficient for production teams.
-- Restricted memberships may operate only on explicitly assigned channels and
-- live runs. Existing memberships default to tenant-wide access for a safe,
-- non-breaking migration.
create type membership_access_scope as enum ('tenant', 'restricted');

alter table memberships
  add column if not exists access_scope membership_access_scope not null default 'tenant';

create table membership_resource_scopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  resource_type text not null check (resource_type in ('channel_connection', 'live_run')),
  resource_id uuid not null,
  created_at timestamptz not null default now(),
  unique (membership_id, resource_type, resource_id)
);

create index membership_resource_scopes_membership_idx
  on membership_resource_scopes (membership_id, resource_type, resource_id);
create index membership_resource_scopes_tenant_resource_idx
  on membership_resource_scopes (tenant_id, resource_type, resource_id);

alter table membership_resource_scopes enable row level security;
alter table membership_resource_scopes force row level security;
create policy tenant_isolation_membership_resource_scopes on membership_resource_scopes
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function guard_membership_access_scope()
returns trigger
language plpgsql
as $$
begin
  if new.role = 'admin' and new.access_scope <> 'tenant' then
    raise exception 'tenant administrators must retain tenant-wide access';
  end if;
  return new;
end;
$$;

create trigger memberships_guard_access_scope
before insert or update of role, access_scope on memberships
for each row execute function guard_membership_access_scope();

create or replace function validate_membership_resource_scope()
returns trigger
language plpgsql
as $$
declare
  membership_tenant_id uuid;
begin
  select tenant_id into membership_tenant_id
  from memberships
  where id = new.membership_id;

  if membership_tenant_id is null then
    raise exception 'membership resource scope requires an existing membership';
  end if;
  if membership_tenant_id <> new.tenant_id then
    raise exception 'membership resource scope must use the membership tenant';
  end if;

  if new.resource_type = 'channel_connection' and not exists (
    select 1 from channel_connections
    where id = new.resource_id and tenant_id = new.tenant_id
  ) then
    raise exception 'channel scope must reference a channel in the membership tenant';
  end if;
  if new.resource_type = 'live_run' and not exists (
    select 1 from live_runs
    where id = new.resource_id and tenant_id = new.tenant_id
  ) then
    raise exception 'live run scope must reference a live run in the membership tenant';
  end if;
  return new;
end;
$$;

create trigger membership_resource_scopes_validate
before insert or update of tenant_id, membership_id, resource_type, resource_id on membership_resource_scopes
for each row execute function validate_membership_resource_scope();
