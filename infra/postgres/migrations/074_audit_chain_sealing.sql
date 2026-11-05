-- L16: audit_chain_heads could be rewritten. seal_audit_event() ran as the inserting role, so every role that
-- writes audit events (the runtime worker included) needed INSERT and UPDATE on audit_chain_heads and could
-- move a tenant's chain head directly. verify_audit_chain() compared hashes with <>, so an event whose
-- event_hash or previous_hash was set to null compared as unknown and the chain still verified.

-- The chain head is now written only by the sealing trigger, which runs as its owner. Roles that insert audit
-- events need no privilege on audit_chain_heads (service-principals.sql no longer grants any). Row-level
-- security still applies to the owner (FORCE), so the head row is the one of the caller's app.tenant_id.
create or replace function seal_audit_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  head public.audit_chain_heads%rowtype;
  material text;
begin
  insert into public.audit_chain_heads (tenant_id)
  values (new.tenant_id)
  on conflict (tenant_id) do nothing;

  select * into head
  from public.audit_chain_heads
  where tenant_id = new.tenant_id
  for update;

  new.chain_sequence := head.last_sequence + 1;
  new.previous_hash := head.last_hash;
  material := jsonb_build_object(
    'id', new.id,
    'tenantId', new.tenant_id,
    'actorId', new.actor_id,
    'eventType', new.event_type,
    'resourceType', new.resource_type,
    'resourceId', new.resource_id,
    'resourceKey', new.resource_key,
    'occurredAt', to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'detail', new.detail
  )::text;
  new.event_hash := encode(public.digest(new.previous_hash || material, 'sha256'), 'hex');

  update public.audit_chain_heads
  set last_sequence = new.chain_sequence, last_hash = new.event_hash, updated_at = now()
  where tenant_id = new.tenant_id;
  return new;
end;
$$;

revoke all on function seal_audit_event() from public;

-- Direct writes are rejected for every role, including the table owner: only a write nested inside a trigger
-- (the sealing trigger on audit_events) may insert or update a head, and nothing may delete or truncate one.
create or replace function guard_audit_chain_head_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if TG_OP in ('INSERT', 'UPDATE') and pg_trigger_depth() > 1 then
    return new;
  end if;
  raise exception 'audit_chain_heads is maintained only by seal_audit_event'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_chain_heads_guard on audit_chain_heads;
create trigger audit_chain_heads_guard
before insert or update or delete on audit_chain_heads
for each row execute function guard_audit_chain_head_write();

drop trigger if exists audit_chain_heads_no_truncate on audit_chain_heads;
create trigger audit_chain_heads_no_truncate
before truncate on audit_chain_heads
for each statement execute function guard_audit_chain_head_write();

-- Same logic as 030, with null-safe comparisons: a null sequence, previous_hash or event_hash is a mismatch.
create or replace function verify_audit_chain(requested_tenant_id uuid)
returns table (verified boolean, sealed_events bigint, legacy_events bigint, detail text)
language plpgsql
as $$
declare
  event_row audit_events%rowtype;
  head audit_chain_heads%rowtype;
  expected_hash text;
  expected_previous_hash text := repeat('0', 64);
  expected_sequence bigint := 1;
  material text;
  sealed_count bigint := 0;
  legacy_count bigint := 0;
begin
  select count(*) into legacy_count
  from audit_events
  where tenant_id = requested_tenant_id and chain_sequence is null;

  for event_row in
    select * from audit_events
    where tenant_id = requested_tenant_id and chain_sequence is not null
    order by chain_sequence
  loop
    material := jsonb_build_object(
      'id', event_row.id,
      'tenantId', event_row.tenant_id,
      'actorId', event_row.actor_id,
      'eventType', event_row.event_type,
      'resourceType', event_row.resource_type,
      'resourceId', event_row.resource_id,
      'resourceKey', event_row.resource_key,
      'occurredAt', to_char(event_row.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'detail', event_row.detail
    )::text;
    expected_hash := encode(digest(expected_previous_hash || material, 'sha256'), 'hex');
    if event_row.chain_sequence is distinct from expected_sequence
      or event_row.previous_hash is distinct from expected_previous_hash
      or event_row.event_hash is distinct from expected_hash then
      return query select false, sealed_count, legacy_count, format('链校验失败于序列 %s', event_row.chain_sequence);
      return;
    end if;
    sealed_count := sealed_count + 1;
    expected_sequence := expected_sequence + 1;
    expected_previous_hash := event_row.event_hash;
  end loop;

  select * into head from audit_chain_heads where tenant_id = requested_tenant_id;
  if head.tenant_id is null then
    if sealed_count = 0 then return query select true, 0::bigint, legacy_count, '尚无哈希链审计记录'; return; end if;
    return query select false, sealed_count, legacy_count, '缺少审计链头'; return;
  end if;
  if head.last_sequence is distinct from sealed_count or head.last_hash is distinct from expected_previous_hash then
    return query select false, sealed_count, legacy_count, '审计链头与事件序列不一致'; return;
  end if;
  return query select true, sealed_count, legacy_count, case when legacy_count > 0 then '哈希链已验证；较早历史记录未纳入链' else '哈希链已验证' end;
end;
$$;
