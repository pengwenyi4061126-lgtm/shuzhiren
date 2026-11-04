-- Runtime services record audit events under a stable service subject. Keep the
-- identity upsert behind a worker-only definer function so no service receives
-- direct users-table write privileges or generic actor-sync capability.
alter function sync_control_plane_actor(uuid, text, text, membership_role) security invoker;

create or replace function runtime_worker_actor(requested_tenant_id uuid, requested_subject text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  resolved_user_id uuid;
begin
  if requested_tenant_id is null or current_setting('app.tenant_id', true) is distinct from requested_tenant_id::text then
    raise exception 'runtime worker actor requires its active tenant transaction';
  end if;
  if requested_subject not in ('runtime-worker', 'runtime-scheduler', 'runtime-watchdog') then
    raise exception 'runtime worker actor subject is not permitted';
  end if;

  insert into users (external_subject, display_name)
  values (requested_subject, case requested_subject when 'runtime-scheduler' then '运行时排期器' when 'runtime-watchdog' then '运行时健康看门狗' else '运行时投递器' end)
  on conflict (external_subject) do update
    set display_name = users.display_name
  returning id into resolved_user_id;

  return resolved_user_id;
end;
$$;

revoke all on function runtime_worker_actor(uuid, text) from public;
