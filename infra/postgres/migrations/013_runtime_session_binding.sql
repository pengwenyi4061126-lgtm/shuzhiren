alter table live_runs add column if not exists runtime_session_id text;

create unique index if not exists live_runs_tenant_runtime_session_idx
  on live_runs (tenant_id, runtime_session_id)
  where runtime_session_id is not null;
