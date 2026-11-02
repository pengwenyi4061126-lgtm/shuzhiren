-- An alert condition has one open operational record per run. Preserve older
-- history by resolving duplicate open rows before enforcing the invariant.
with ranked as (
  select id, row_number() over (partition by tenant_id, live_run_id, code order by opened_at, id) as position
  from runtime_alerts
  where status = 'open'
)
update runtime_alerts alert
set status = 'resolved', resolved_at = coalesce(alert.resolved_at, now())
from ranked
where alert.id = ranked.id and ranked.position > 1;

create unique index runtime_alerts_one_open_condition_key
  on runtime_alerts (tenant_id, live_run_id, code)
  where status = 'open';
