create type incident_status as enum ('open', 'resolved');

create table incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  runtime_alert_id uuid references runtime_alerts(id) on delete restrict,
  severity alert_severity not null,
  title text not null check (char_length(title) between 1 and 240),
  status incident_status not null default 'open',
  owner_id uuid not null references users(id) on delete restrict,
  opened_at timestamptz not null default now(),
  resolution text check (resolution is null or char_length(resolution) between 10 and 2000),
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete restrict,
  unique (tenant_id, runtime_alert_id)
);

create index incidents_tenant_status_opened_idx on incidents (tenant_id, status, opened_at desc);
create index incidents_tenant_run_opened_idx on incidents (tenant_id, live_run_id, opened_at desc);

alter table incidents enable row level security;
alter table incidents force row level security;
create policy tenant_isolation_incidents on incidents
  using (tenant_id::text = current_setting('app.tenant_id', true));
