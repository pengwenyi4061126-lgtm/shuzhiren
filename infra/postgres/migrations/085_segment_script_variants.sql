-- Script variants (P1): a program segment can carry up to four extra versions of its runtime script, and every
-- script dispatch of a live run is recorded in an append-only rotation ledger. The control plane and the runtime
-- worker choose the next version from the ledger: version 0 is runtime_script, versions 1..k are
-- runtime_script_variants[0..k-1]; the first dispatch of a segment in a run uses version 0, later ones continue
-- after the version of the last ledger row (modulo the version count), skipping versions the broadcast check
-- refuses. The ledger row is written in the same transaction as the media.dispatch outbox event it describes.
--
-- The variants are a column of show_revision_segments, so reject_show_revision_segment_mutation (064), the
-- require_runtime_scripts_for_* triggers and the revision freeze cover them without any change.
-- Foreign keys between tenant tables use the composite (tenant_id, ...) form directly (078).

-- CHECK constraints cannot contain subqueries, so the per-element rules live in an immutable function. The CASE
-- keeps the array functions away from non-array values: such a value is rejected instead of raising an error.
-- "Blank" means only ASCII whitespace (btrim alone would leave a tab); the regex class is spelled out so the
-- result does not depend on the database locale.
create or replace function script_variants_valid(variants jsonb, primary_script text)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(variants) <> 'array' then false
    else jsonb_array_length(variants) <= 4
      and not exists (
        select 1 from jsonb_array_elements(variants) as v(value)
        where jsonb_typeof(v.value) <> 'string'
          or char_length(v.value #>> '{}') not between 1 and 800
          or v.value #>> '{}' ~ '^[ \t\r\n\f\v]*$'
          or v.value #>> '{}' = primary_script)
      and (select count(distinct v.value) from jsonb_array_elements(variants) as v(value)) = jsonb_array_length(variants)
  end
$$;

alter table show_revision_segments
  add column runtime_script_variants jsonb not null default '[]'::jsonb,
  add constraint show_revision_segments_runtime_script_variants_check check (
    script_variants_valid(runtime_script_variants, runtime_script)
    and (jsonb_array_length(runtime_script_variants) = 0
         or (runtime_script is not null and kind in ('prepared_product', 'interactive'))));

-- One row per script dispatch of a live run and segment. play_seq counts the dispatches of that segment in that
-- run from 1; variant_index is the chosen version (0 = runtime_script) out of variant_count versions; the
-- skipped indexes are the versions refused by the broadcast check before the chosen one.
create table live_run_script_plays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null,
  show_revision_id uuid not null,
  segment_id uuid not null,
  play_seq integer not null check (play_seq >= 1),
  variant_index integer not null check (variant_index between 0 and 4),
  variant_count integer not null check (variant_count between 1 and 5),
  script_sha256 char(64) not null check (script_sha256 ~ '^[0-9a-f]{64}$'),
  control_action text not null check (control_action in ('START', 'RECOVER', 'INSERT_PROGRAM', 'ROLLBACK_PROGRAM', 'SCHEDULED_START')),
  outbox_event_id uuid not null,
  skipped_variant_indexes integer[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, live_run_id, segment_id, play_seq),
  unique (tenant_id, outbox_event_id),
  check (variant_index < variant_count),
  foreign key (tenant_id, live_run_id) references live_runs (tenant_id, id),
  foreign key (tenant_id, segment_id) references show_revision_segments (tenant_id, id),
  foreign key (tenant_id, outbox_event_id) references outbox_events (tenant_id, id)
);
create index live_run_script_plays_last_idx on live_run_script_plays (tenant_id, live_run_id, segment_id, play_seq desc);
alter table live_run_script_plays enable row level security;
alter table live_run_script_plays force row level security;
create policy tenant_isolation_live_run_script_plays on live_run_script_plays using (tenant_id::text = current_setting('app.tenant_id', true));

-- The ledger is append-only. An insert must describe a real dispatch: the run's current revision, one of that
-- revision's runnable segments, the version count of that segment, the hash of the chosen version's text, and
-- the next play_seq of the segment in the run. The caller holds the run row lock, so concurrent writers are
-- serialized; the unique key on (tenant, run, segment, play_seq) is the second line of defense.
create or replace function enforce_live_run_script_play()
returns trigger
language plpgsql
as $$
declare
  run_revision_id uuid;
  segment_revision_id uuid;
  segment_kind program_segment_kind;
  primary_script text;
  variants jsonb;
  chosen_script text;
  expected_seq integer;
begin
  if TG_OP = 'UPDATE' or TG_OP = 'DELETE' then
    raise exception 'live run script plays are append-only';
  end if;

  select r.show_revision_id into run_revision_id
  from live_runs r where r.tenant_id = new.tenant_id and r.id = new.live_run_id;
  if run_revision_id is null or run_revision_id is distinct from new.show_revision_id then
    raise exception 'live run script plays must use the current show revision of the run';
  end if;

  select s.show_revision_id, s.kind, s.runtime_script, s.runtime_script_variants
  into segment_revision_id, segment_kind, primary_script, variants
  from show_revision_segments s where s.tenant_id = new.tenant_id and s.id = new.segment_id;
  if segment_revision_id is null or segment_revision_id is distinct from run_revision_id then
    raise exception 'live run script plays must use a segment of the current show revision of the run';
  end if;
  if segment_kind not in ('prepared_product', 'interactive') or primary_script is null then
    raise exception 'live run script plays require a runnable program segment';
  end if;

  if new.variant_count is distinct from 1 + jsonb_array_length(variants) then
    raise exception 'live run script play variant count does not match the segment';
  end if;
  chosen_script := case when new.variant_index = 0 then primary_script else variants ->> (new.variant_index - 1) end;
  if chosen_script is null
    or new.script_sha256 is distinct from encode(sha256(convert_to(chosen_script, 'UTF8')), 'hex') then
    raise exception 'live run script play hash does not match the selected script version';
  end if;

  select coalesce(max(p.play_seq), 0) + 1 into expected_seq
  from live_run_script_plays p
  where p.tenant_id = new.tenant_id and p.live_run_id = new.live_run_id and p.segment_id = new.segment_id;
  if new.play_seq is distinct from expected_seq then
    raise exception 'live run script play sequence must follow the last recorded play of the segment';
  end if;
  return new;
end;
$$;
create trigger live_run_script_plays_governed
before insert or update or delete on live_run_script_plays
for each row execute function enforce_live_run_script_play();
