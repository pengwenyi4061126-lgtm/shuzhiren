create type outbox_state as enum ('pending', 'delivering', 'delivered', 'failed');

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid,
  payload jsonb not null,
  state outbox_state not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index outbox_events_tenant_delivery_idx
  on outbox_events (tenant_id, state, available_at);

alter table outbox_events enable row level security;

create policy tenant_isolation_outbox_events
  on outbox_events
  using (tenant_id::text = current_setting('app.tenant_id', true));
