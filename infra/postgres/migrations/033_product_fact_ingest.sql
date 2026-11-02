create table product_fact_ingest_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  external_event_id text not null check (char_length(external_event_id) between 1 and 200),
  product_version_id uuid not null references product_versions(id) on delete restrict,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  unique (tenant_id, external_event_id)
);

create index product_fact_ingest_events_tenant_received_idx on product_fact_ingest_events (tenant_id, received_at desc);
alter table product_fact_ingest_events enable row level security;
alter table product_fact_ingest_events force row level security;
create policy tenant_isolation_product_fact_ingest_events on product_fact_ingest_events using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_product_fact_ingest_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'product_fact_ingest_events is append-only';
end;
$$;

create trigger product_fact_ingest_events_append_only before update or delete on product_fact_ingest_events for each row execute function reject_product_fact_ingest_event_mutation();
