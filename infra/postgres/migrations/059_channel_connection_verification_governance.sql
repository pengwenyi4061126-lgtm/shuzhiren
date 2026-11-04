alter table channel_connections
  add constraint channel_connections_verification_evidence_ref_check
  check (
    verification_evidence_ref is null
    or verification_evidence_ref ~ '^(evidence|demo)://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$'
    or verification_evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'
  ) not valid;

alter table channel_connections
  add constraint channel_connections_connected_verification_check
  check (
    status <> 'connected'
    or (last_verified_at is not null and verification_evidence_ref is not null and verified_by is not null)
  ) not valid;

create or replace function enforce_channel_connection_verification()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then
    raise exception 'channel connections are immutable';
  end if;

  if tg_op = 'insert' then
    if new.status = 'connected'
      and (new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null) then
      raise exception 'connected channel connections require verification evidence, time, and actor';
    end if;
    return new;
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

  if new.status is distinct from old.status
    or new.last_verified_at is distinct from old.last_verified_at
    or new.verification_evidence_ref is distinct from old.verification_evidence_ref
    or new.verified_by is distinct from old.verified_by then
    if new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null then
      raise exception 'channel connection verification updates require evidence, time, and actor';
    end if;
  end if;

  if new.status = 'connected'
    and (new.last_verified_at is null or new.verification_evidence_ref is null or new.verified_by is null) then
    raise exception 'connected channel connections require verification evidence, time, and actor';
  end if;
  return new;
end;
$$;

drop trigger if exists channel_connections_governed_verification on channel_connections;
create trigger channel_connections_governed_verification
before insert or update or delete on channel_connections
for each row execute function enforce_channel_connection_verification();
