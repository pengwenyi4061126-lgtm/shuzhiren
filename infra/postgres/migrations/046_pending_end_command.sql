-- Ending a live run is safety critical: the control plane must not report ENDED
-- until the runtime confirms that its stop command was accepted.
alter table live_runs
  add column if not exists pending_media_event_id uuid references outbox_events(id) on delete restrict;

create unique index if not exists live_runs_pending_media_event_id_key
  on live_runs (pending_media_event_id)
  where pending_media_event_id is not null;
