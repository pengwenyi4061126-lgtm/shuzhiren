-- M10: the runtime worker now delivers a media.dispatch event only after every earlier media.dispatch event of
-- the same live run, ordered by (created_at, id), is delivered, cancelled or exhausted. created_at defaulted to
-- the inserting transaction's start time, so a transaction that started earlier but committed later produced an
-- event that sorted before one the worker had already claimed, and both could be in flight at once.
--
-- Inserting a media.dispatch event now locks its live run and takes created_at from the clock while holding that
-- lock. Inserts for one run are serialized up to commit, so an event is visible to the worker only after every
-- event of the same run with an earlier created_at. The worker's insert paths already lock the run first; the
-- console's command path gets the lock here. Both roles hold UPDATE on live_runs, which FOR UPDATE requires.
create index if not exists outbox_events_media_aggregate_order_idx
  on outbox_events (tenant_id, aggregate_id, created_at, id)
  where event_type = 'media.dispatch';

create or replace function sequence_media_dispatch_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' and new.event_type = 'media.dispatch' and new.aggregate_id is not null then
    perform 1 from public.live_runs where id = new.aggregate_id for update;
    new.created_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists outbox_events_media_dispatch_sequence on outbox_events;
create trigger outbox_events_media_dispatch_sequence
before insert on outbox_events
for each row execute function sequence_media_dispatch_insert();
