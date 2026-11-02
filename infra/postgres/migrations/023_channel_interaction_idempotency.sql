alter table live_interactions add column external_event_id text;

create unique index live_interactions_external_event_id_idx
  on live_interactions (tenant_id, live_run_id, source, external_event_id)
  where external_event_id is not null;
