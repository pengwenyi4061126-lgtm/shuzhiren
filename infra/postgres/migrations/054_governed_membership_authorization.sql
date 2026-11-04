-- Human authorization is derived from an active, tenant-scoped database
-- membership. OIDC establishes identity only; a token role must never create,
-- reactivate, or overwrite a membership role.
alter table memberships
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists status text not null default 'active',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists suspended_at timestamptz,
  add column if not exists revoked_at timestamptz;

alter table memberships
  add constraint memberships_status_check check (status in ('active', 'suspended', 'revoked'));

create unique index memberships_id_idx on memberships (id);
create index memberships_tenant_active_role_idx on memberships (tenant_id, status, role);

alter table memberships enable row level security;
alter table memberships force row level security;
create policy tenant_isolation_memberships on memberships
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function protect_last_active_tenant_admin()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.status = 'active' and not exists (
      select 1 from memberships
      where tenant_id = old.tenant_id and status = 'active' and role = 'admin' and id <> old.id
    ) then
      raise exception 'cannot remove the last active tenant admin';
    end if;
    return old;
  end if;

  if old.role = 'admin' and old.status = 'active'
    and (new.role <> 'admin' or new.status <> 'active')
    and not exists (
      select 1 from memberships
      where tenant_id = old.tenant_id and status = 'active' and role = 'admin' and id <> old.id
    ) then
    raise exception 'cannot remove the last active tenant admin';
  end if;

  if new.status = 'suspended' and old.status <> 'suspended' then new.suspended_at := now(); end if;
  if new.status = 'revoked' and old.status <> 'revoked' then new.revoked_at := now(); end if;
  if new.status = 'active' then new.suspended_at := null; new.revoked_at := null; end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger memberships_protect_last_admin
before update or delete on memberships
for each row execute function protect_last_active_tenant_admin();

-- Retain the existing function signature for runtime/audit callers, but make
-- it identity-only. requested_role is deliberately ignored.
create or replace function sync_control_plane_actor(
  requested_tenant_id uuid,
  requested_subject text,
  requested_name text,
  requested_role membership_role
) returns uuid language plpgsql as $$
declare
  resolved_user_id uuid;
begin
  if requested_tenant_id is null or requested_subject is null or length(trim(requested_subject)) = 0 then
    raise exception 'tenant id and actor subject are required';
  end if;

  insert into users (external_subject, display_name)
  values (requested_subject, coalesce(nullif(trim(requested_name), ''), requested_subject))
  on conflict (external_subject) do update
    set display_name = excluded.display_name
  returning id into resolved_user_id;

  return resolved_user_id;
end;
$$;
