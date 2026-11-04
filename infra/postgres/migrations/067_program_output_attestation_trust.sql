alter table program_output_observations
  add column verifier_issuer text not null default 'legacy_untrusted' check (verifier_issuer ~ '^[a-z][a-z0-9_-]{1,63}$'),
  add column verifier_key_id text not null default 'legacy_untrusted' check (verifier_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  add column attested_at timestamptz not null default now(),
  add column attestation_expires_at timestamptz not null default now(),
  add column attestation_sha256 text not null default repeat('0', 64) check (attestation_sha256 ~ '^[0-9a-f]{64}$');

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
  if new.observed_at < delivered_at_value - interval '5 seconds' or new.observed_at > delivered_at_value + interval '15 minutes' or new.observed_at > now() + interval '5 minutes' then
    raise exception 'program output observation time is outside the accepted real-time command window';
  end if;
  if new.attested_at > now() + interval '1 minute' or new.attestation_expires_at <= new.attested_at or new.attestation_expires_at > new.attested_at + interval '10 minutes' or new.observed_at < new.attested_at - interval '1 minute' or new.observed_at > new.attestation_expires_at + interval '1 minute' then
    raise exception 'program output attestation time is invalid';
  end if;
  return new;
end;
$$;
