create type entitlement_code as enum ('max_concurrent_live_runs', 'monthly_live_minutes');

create table tenant_entitlements (
  tenant_id uuid not null references tenants(id) on delete restrict,
  code entitlement_code not null,
  limit_value integer not null check (limit_value > 0),
  effective_from date not null default current_date,
  effective_until date,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete restrict,
  primary key (tenant_id, code),
  check (effective_until is null or effective_until >= effective_from)
);

create table usage_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  code entitlement_code not null,
  live_run_id uuid references live_runs(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  occurred_at timestamptz not null default now(),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, idempotency_key)
);

create index usage_records_tenant_code_occurred_idx
  on usage_records (tenant_id, code, occurred_at desc);

alter table tenant_entitlements enable row level security;
alter table tenant_entitlements force row level security;
create policy tenant_isolation_tenant_entitlements on tenant_entitlements
  using (tenant_id::text = current_setting('app.tenant_id', true));

alter table usage_records enable row level security;
alter table usage_records force row level security;
create policy tenant_isolation_usage_records on usage_records
  using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_usage_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'usage_records is append-only';
end;
$$;

create trigger usage_records_append_only
before update or delete on usage_records
for each row execute function reject_usage_record_mutation();
