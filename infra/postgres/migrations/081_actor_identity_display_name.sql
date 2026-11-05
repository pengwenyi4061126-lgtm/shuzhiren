-- L8: sync_control_plane_actor (054) inserted the request's actor with "on conflict (external_subject) do update
-- set display_name = excluded.display_name". users is shared by every tenant, so any tenant's request context
-- (a development header identity, a service caller or a token-derived name) renamed that person everywhere.
--
-- An existing subject now keeps its id and its display name whatever requested_name is; requested_name only names
-- a subject seen for the first time. When another transaction is inserting the same subject and has not yet
-- committed, ON CONFLICT DO NOTHING waits for it; the read that follows then finds the row under READ COMMITTED.
-- Under REPEATABLE READ or SERIALIZABLE the row may still be invisible, and the call fails with 40001 so the
-- caller retries instead of using a null id. requested_role stays ignored (054). Security stays INVOKER (056).
create or replace function sync_control_plane_actor(
  requested_tenant_id uuid,
  requested_subject text,
  requested_name text,
  requested_role membership_role
) returns uuid
language plpgsql
security invoker
as $$
declare
  resolved_user_id uuid;
begin
  if requested_tenant_id is null or requested_subject is null or length(trim(requested_subject)) = 0 then
    raise exception 'tenant id and actor subject are required';
  end if;

  insert into users (external_subject, display_name)
  values (requested_subject, coalesce(nullif(trim(requested_name), ''), requested_subject))
  on conflict (external_subject) do nothing
  returning id into resolved_user_id;

  if resolved_user_id is null then
    select id into resolved_user_id from users where external_subject = requested_subject;
  end if;
  if resolved_user_id is null then
    raise exception 'actor identity is being provisioned concurrently; retry' using errcode = 'serialization_failure';
  end if;

  return resolved_user_id;
end;
$$;
