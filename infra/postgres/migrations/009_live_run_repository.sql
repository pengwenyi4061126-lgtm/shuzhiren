-- Immutable-at-arming configuration snapshot used by the live-run control plane.
alter table live_runs
  add column if not exists channel_connection_id uuid references channel_connections(id) on delete restrict,
  add column if not exists product_version_id uuid references product_versions(id) on delete restrict,
  add column if not exists has_operator boolean not null default false,
  add column if not exists rights_approved boolean not null default false,
  add column if not exists has_approved_sku_version boolean not null default false,
  add column if not exists has_fallback_program boolean not null default false,
  add column if not exists channel_ready boolean not null default false,
  add column if not exists output_ready boolean not null default false,
  add column if not exists ai_disclosure_enabled boolean not null default false;

create index if not exists live_runs_tenant_updated_idx on live_runs (tenant_id, updated_at desc);

-- Keeps a verified OIDC principal usable as an auditable database actor.
-- Tenant membership is still constrained by the tenant claim validated before this repository is called.
create or replace function sync_control_plane_actor(
  requested_tenant_id uuid,
  requested_subject text,
  requested_name text,
  requested_role membership_role
) returns uuid language plpgsql as $$
declare
  resolved_user_id uuid;
begin
  insert into users (external_subject, display_name)
  values (requested_subject, requested_name)
  on conflict (external_subject) do update set display_name = excluded.display_name
  returning id into resolved_user_id;

  insert into memberships (tenant_id, user_id, role)
  values (requested_tenant_id, resolved_user_id, requested_role)
  on conflict (tenant_id, user_id) do update set role = excluded.role;

  return resolved_user_id;
end;
$$;
