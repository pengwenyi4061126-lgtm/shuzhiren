-- A scheduled start remains ARMED until the runtime gateway acknowledges the
-- corresponding outbox command.  The reference also prevents the scheduler
-- from enqueueing a second start command while the first one is being retried.
alter table live_runs
  add column if not exists scheduled_start_event_id uuid references outbox_events(id) on delete restrict;

create unique index if not exists live_runs_scheduled_start_event_id_key
  on live_runs (scheduled_start_event_id)
  where scheduled_start_event_id is not null;
