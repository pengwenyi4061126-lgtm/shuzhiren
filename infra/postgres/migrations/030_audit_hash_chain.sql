create table audit_chain_heads (
  tenant_id uuid primary key references tenants(id) on delete restrict,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_hash text not null default repeat('0', 64) check (last_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

alter table audit_events
  add column if not exists chain_sequence bigint,
  add column if not exists previous_hash text,
  add column if not exists event_hash text;

create unique index audit_events_tenant_chain_sequence_idx
  on audit_events (tenant_id, chain_sequence)
  where chain_sequence is not null;

alter table audit_chain_heads enable row level security;
alter table audit_chain_heads force row level security;
create policy tenant_isolation_audit_chain_heads on audit_chain_heads
  using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function seal_audit_event()
returns trigger
language plpgsql
as $$
declare
  head audit_chain_heads%rowtype;
  material text;
begin
  insert into audit_chain_heads (tenant_id)
  values (new.tenant_id)
  on conflict (tenant_id) do nothing;

  select * into head
  from audit_chain_heads
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
  new.event_hash := encode(digest(new.previous_hash || material, 'sha256'), 'hex');

  update audit_chain_heads
  set last_sequence = new.chain_sequence, last_hash = new.event_hash, updated_at = now()
  where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger audit_events_hash_chain
before insert on audit_events
for each row execute function seal_audit_event();

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
    if event_row.chain_sequence <> expected_sequence or event_row.previous_hash <> expected_previous_hash or event_row.event_hash <> expected_hash then
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
  if head.last_sequence <> sealed_count or head.last_hash <> expected_previous_hash then
    return query select false, sealed_count, legacy_count, '审计链头与事件序列不一致'; return;
  end if;
  return query select true, sealed_count, legacy_count, case when legacy_count > 0 then '哈希链已验证；较早历史记录未纳入链' else '哈希链已验证' end;
end;
$$;
