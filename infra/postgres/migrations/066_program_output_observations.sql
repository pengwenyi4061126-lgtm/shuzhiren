create table program_output_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  outbox_event_id uuid not null references outbox_events(id) on delete restrict,
  runtime_session_id text not null check (runtime_session_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  command_id text not null check (char_length(command_id) between 1 and 128),
  program_segment_id uuid not null references show_revision_segments(id) on delete restrict,
  control_action text not null check (control_action in ('START', 'RECOVER', 'SCHEDULED_START', 'INSERT_PROGRAM', 'ROLLBACK_PROGRAM')),
  source text not null check (source ~ '^[a-z][a-z0-9_-]{1,63}$'),
  evidence_ref text not null check (evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  media_time_ms bigint not null check (media_time_ms >= 0),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, outbox_event_id)
);

create index program_output_observations_run_observed_idx
  on program_output_observations (tenant_id, live_run_id, observed_at desc);

alter table program_output_observations enable row level security;
alter table program_output_observations force row level security;
create policy tenant_isolation_program_output_observations on program_output_observations
  using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function govern_program_output_observation()
returns trigger
language plpgsql
as $$
declare
  delivered_at_value timestamptz;
begin
  if tg_op <> 'INSERT' then
    raise exception 'program output observations are immutable';
  end if;

  if not exists (
    select 1
    from live_runs run
    join show_revision_segments segment on segment.id = new.program_segment_id
    where run.id = new.live_run_id
      and run.tenant_id = new.tenant_id
      and run.runtime_session_id = new.runtime_session_id
      and segment.tenant_id = new.tenant_id
      and segment.show_revision_id = run.show_revision_id
  ) then
    raise exception 'program output observation must bind this tenant run, session, and frozen program segment';
  end if;

  select event.delivered_at into delivered_at_value
  from outbox_events event
  where event.id = new.outbox_event_id
    and event.tenant_id = new.tenant_id
    and event.event_type = 'media.dispatch'
    and event.aggregate_type = 'live_run'
    and event.aggregate_id = new.live_run_id
    and event.state = 'delivered'
    and event.payload ->> 'sessionId' = new.runtime_session_id
    and event.payload -> 'command' ->> 'id' = new.command_id
    and event.payload -> 'command' -> 'payload' ->> 'controlAction' = new.control_action
    and event.payload -> 'command' -> 'payload' ->> 'programSegmentId' = new.program_segment_id::text;
  if delivered_at_value is null then
    raise exception 'program output observation must reference a delivered bound media command';
  end if;
  if new.observed_at < delivered_at_value - interval '5 seconds' or new.observed_at > now() + interval '5 minutes' then
    raise exception 'program output observation time is outside the accepted command window';
  end if;
  return new;
end;
$$;

create trigger program_output_observations_append_only
before insert or update or delete on program_output_observations
for each row execute function govern_program_output_observation();
