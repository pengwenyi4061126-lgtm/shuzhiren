create type alert_severity as enum ('warning', 'critical');
create type alert_status as enum ('open', 'resolved');

create table runtime_health_samples (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  output_connected boolean not null,
  inference_fps numeric(6,2) not null,
  output_fps numeric(6,2) not null,
  av_sync_ms integer not null,
  bitrate_mbps numeric(7,3) not null,
  gpu_utilization integer not null,
  gpu_memory_mib integer not null,
  fallback_ready boolean not null,
  sampled_at timestamptz not null default now()
);

create table runtime_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  severity alert_severity not null,
  code text not null,
  message text not null,
  status alert_status not null default 'open',
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index runtime_health_samples_run_sampled_idx on runtime_health_samples (tenant_id, live_run_id, sampled_at desc);
create index runtime_alerts_tenant_status_idx on runtime_alerts (tenant_id, status, opened_at desc);

alter table runtime_health_samples enable row level security;
alter table runtime_alerts enable row level security;
create policy tenant_isolation_runtime_health_samples on runtime_health_samples using (tenant_id::text = current_setting('app.tenant_id', true));
create policy tenant_isolation_runtime_alerts on runtime_alerts using (tenant_id::text = current_setting('app.tenant_id', true));
