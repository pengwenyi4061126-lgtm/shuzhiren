create type alert_notification_state as enum ('pending', 'delivering', 'delivered', 'failed');

create table alert_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  runtime_alert_id uuid not null references runtime_alerts(id) on delete restrict,
  target_id text not null check (char_length(target_id) between 1 and 80),
  state alert_notification_state not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, runtime_alert_id, target_id)
);

create index alert_notification_deliveries_claim_idx
  on alert_notification_deliveries (tenant_id, state, available_at, lease_expires_at, created_at);

alter table alert_notification_deliveries enable row level security;
alter table alert_notification_deliveries force row level security;
create policy tenant_isolation_alert_notification_deliveries on alert_notification_deliveries
  using (tenant_id::text = current_setting('app.tenant_id', true));
