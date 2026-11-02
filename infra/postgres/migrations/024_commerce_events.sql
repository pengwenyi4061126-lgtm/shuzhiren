create type commerce_event_type as enum ('view', 'product_click', 'add_to_cart', 'order_paid', 'refund');

-- Normalized, non-PII commerce facts from a private channel adapter. Amounts are
-- integer minor units; personal buyer information must never enter this table.
create table commerce_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  channel_connection_id uuid not null references channel_connections(id) on delete restrict,
  external_event_id text not null,
  event_type commerce_event_type not null,
  occurred_at timestamptz not null default now(),
  order_reference text,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  currency char(3) not null default 'CNY' check (currency = 'CNY'),
  created_at timestamptz not null default now(),
  unique (tenant_id, channel_connection_id, external_event_id),
  check ((event_type in ('order_paid', 'refund') and amount_cents > 0) or (event_type not in ('order_paid', 'refund') and amount_cents = 0))
);

create index commerce_events_run_occurred_idx on commerce_events (tenant_id, live_run_id, occurred_at desc);
create index commerce_events_run_type_idx on commerce_events (tenant_id, live_run_id, event_type, occurred_at desc);

alter table commerce_events enable row level security;
alter table commerce_events force row level security;
create policy tenant_isolation_commerce_events on commerce_events using (tenant_id::text = current_setting('app.tenant_id', true));
