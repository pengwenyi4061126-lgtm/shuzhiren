drop index if exists live_runs_tenant_runtime_session_idx;

create unique index if not exists live_runs_tenant_active_runtime_session_idx
  on live_runs (tenant_id, runtime_session_id)
  where runtime_session_id is not null
    and state in ('PREFLIGHT', 'ARMED', 'LIVE', 'DEGRADED');
