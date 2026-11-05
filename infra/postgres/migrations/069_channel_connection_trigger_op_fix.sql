-- Audit C1: 059 and 061 compared TG_OP with lower-case literals. TG_OP is
-- always upper case, so neither branch ever matched: every INSERT fell through
-- to the configuration check and failed as "configuration is immutable", and
-- DELETE reported the same misleading error. This replaces only the function
-- body; the channel_connections_governed_verification trigger references the
-- function and picks up the new body immediately. 059 and 061 stay unchanged.
create or replace function enforce_channel_connection_verification()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'channel connections cannot be deleted';
  end if;

  if TG_OP = 'INSERT' then
    if new.status = 'connected'
      and (new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null) then
      raise exception 'connected channel connections require verification evidence, time, and actor';
    end if;
    if new.verified_by is not null and not exists (
      select 1 from memberships where tenant_id = new.tenant_id and user_id = new.verified_by and status = 'active'
    ) then
      raise exception 'channel verification actor must be an active tenant member';
    end if;
    return new;
  end if;

  if TG_OP <> 'UPDATE' then
    raise exception 'enforce_channel_connection_verification does not handle %', TG_OP;
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.name is distinct from old.name
    or new.provider is distinct from old.provider
    or new.output_protocol is distinct from old.output_protocol
    or new.secret_ref is distinct from old.secret_ref
    or new.capabilities is distinct from old.capabilities
    or new.created_at is distinct from old.created_at then
    raise exception 'channel connection configuration is immutable';
  end if;

  if new.status = 'disabled'
    and new.last_verified_at is null
    and new.verification_evidence_ref is null
    and new.verified_by is null
    and (old.status = 'connected' or old.verification_evidence_ref is not null) then
    return new;
  end if;

  if new.status is distinct from old.status
    or new.last_verified_at is distinct from old.last_verified_at
    or new.verification_evidence_ref is distinct from old.verification_evidence_ref
    or new.verified_by is distinct from old.verified_by then
    if new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null then
      raise exception 'channel connection verification updates require evidence, time, and actor';
    end if;
    if not exists (
      select 1 from memberships where tenant_id = new.tenant_id and user_id = new.verified_by and status = 'active'
    ) then
      raise exception 'channel verification actor must be an active tenant member';
    end if;
  end if;

  if new.status = 'connected'
    and (new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null) then
    raise exception 'connected channel connections require verification evidence, time, and actor';
  end if;
  return new;
end;
$$;
