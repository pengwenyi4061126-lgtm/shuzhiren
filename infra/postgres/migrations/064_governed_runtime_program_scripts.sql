-- A runtime instruction is governed program content. It is added as a nullable
-- field so historical approved revisions remain readable; new writable drafts
-- are required to supply it by the application and approval checks.
alter table show_revision_segments
  add column if not exists runtime_script text;

alter table show_revision_segments
  add constraint show_revision_segments_runtime_script_length
  check (runtime_script is null or char_length(runtime_script) between 1 and 800);

-- These cursors are set only after a gateway acknowledgement. They preserve the
-- last accepted program position and prevent concurrent insert/rollback commands.
alter table live_runs
  add column if not exists active_program_segment_id uuid references show_revision_segments(id) on delete restrict,
  add column if not exists active_insert_source_segment_id uuid references show_revision_segments(id) on delete restrict,
  add column if not exists pending_program_transition_event_id uuid references outbox_events(id) on delete restrict;

create unique index if not exists live_runs_pending_program_transition_event_id_key
  on live_runs (pending_program_transition_event_id)
  where pending_program_transition_event_id is not null;

create index if not exists show_revision_segments_runtime_script_idx
  on show_revision_segments (tenant_id, show_revision_id, position)
  where runtime_script is not null;

create or replace function require_runtime_scripts_for_program_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approval_status = 'approved' and old.approval_status <> 'approved'
    and exists (
      select 1 from show_revision_segments
      where show_revision_id = new.id
        and kind in ('prepared_product', 'interactive')
        and runtime_script is null
    ) then
    raise exception 'Approved runnable program segments require frozen runtime scripts';
  end if;
  return new;
end;
$$;

create trigger show_revisions_require_runtime_scripts_for_approval
before update of approval_status on show_revisions
for each row execute function require_runtime_scripts_for_program_approval();

create or replace function require_runtime_scripts_for_program_submission()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pending_approval' and old.status = 'draft'
    and exists (
      select 1 from show_revision_segments
      where show_revision_id = new.candidate_revision_id
        and kind in ('prepared_product', 'interactive')
        and runtime_script is null
    ) then
    raise exception 'Submitted runnable program segments require frozen runtime scripts';
  end if;
  return new;
end;
$$;

create trigger show_program_change_requests_require_runtime_scripts
before update of status on show_program_change_requests
for each row execute function require_runtime_scripts_for_program_submission();

-- Do not allow a caller to create an approved revision and append unreviewed
-- segments afterwards. The existing draft/candidate editing paths remain intact.
create or replace function reject_show_revision_segment_mutation()
returns trigger
language plpgsql
as $$
declare
  revision_id uuid;
begin
  if tg_op = 'UPDATE' and new.show_revision_id is distinct from old.show_revision_id then
    raise exception 'Show program segments cannot move between revisions';
  end if;
  revision_id := case when tg_op = 'DELETE' then old.show_revision_id else new.show_revision_id end;

  if exists (select 1 from live_runs where show_revision_id = revision_id and state = 'DRAFT') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id and status = 'draft') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT'
    and not exists (select 1 from live_runs where show_revision_id = revision_id)
    and not exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id)
    and exists (select 1 from show_revisions where id = revision_id and approval_status = 'draft') then
    return new;
  end if;
  raise exception 'Show program segments are editable only in an attached DRAFT run or draft revision request';
end;
$$;
