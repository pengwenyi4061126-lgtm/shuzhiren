alter table live_runs add column if not exists scheduled_at timestamptz;

create index if not exists live_runs_tenant_scheduled_idx
  on live_runs (tenant_id, scheduled_at asc nulls last);
