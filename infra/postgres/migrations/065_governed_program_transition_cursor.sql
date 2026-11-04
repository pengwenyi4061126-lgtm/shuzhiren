alter table live_runs
  add column if not exists active_insert_program_segment_id uuid references show_revision_segments(id) on delete restrict;

create or replace function validate_live_run_program_cursor()
returns trigger
language plpgsql
as $$
declare
  pointer_id uuid;
begin
  foreach pointer_id in array array[new.active_program_segment_id, new.active_insert_source_segment_id, new.active_insert_program_segment_id]
  loop
    if pointer_id is not null and not exists (
      select 1 from show_revision_segments
      where id = pointer_id and tenant_id = new.tenant_id and show_revision_id = new.show_revision_id
    ) then
      raise exception 'Live program cursor must reference a segment from the bound tenant revision';
    end if;
  end loop;

  if new.active_insert_program_segment_id is null and new.active_insert_source_segment_id is not null then
    raise exception 'Live program insert source requires an active inserted segment';
  end if;
  if new.active_insert_program_segment_id is not null and new.active_program_segment_id is distinct from new.active_insert_program_segment_id then
    raise exception 'Active inserted program segment must match the active program cursor';
  end if;
  if new.pending_program_transition_event_id is not null and not exists (
    select 1 from outbox_events
    where id = new.pending_program_transition_event_id and tenant_id = new.tenant_id
      and event_type = 'media.dispatch' and aggregate_type = 'live_run' and aggregate_id = new.id
  ) then
    raise exception 'Pending program transition must reference this live run media outbox event';
  end if;
  return new;
end;
$$;

create trigger live_runs_governed_program_cursor
before insert or update of show_revision_id, active_program_segment_id, active_insert_source_segment_id, active_insert_program_segment_id, pending_program_transition_event_id on live_runs
for each row execute function validate_live_run_program_cursor();
