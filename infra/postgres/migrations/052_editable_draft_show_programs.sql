alter table show_revisions
  add column if not exists approved_by uuid references users(id) on delete restrict,
  add column if not exists approved_at timestamptz;

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

  if not exists (
    select 1
    from live_runs
    where show_revision_id = revision_id
      and state = 'DRAFT'
  ) then
    raise exception 'Show program segments are editable only while the live run is in DRAFT';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists show_revision_segments_immutable on show_revision_segments;
create trigger show_revision_segments_immutable
before insert or update or delete on show_revision_segments
for each row execute function reject_show_revision_segment_mutation();

create or replace function enforce_show_revision_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'show_revisions is immutable';
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.show_id is distinct from old.show_id
    or new.revision is distinct from old.revision
    or new.plan is distinct from old.plan
    or new.created_at is distinct from old.created_at
    or new.approved_by is distinct from old.approved_by and old.approval_status <> 'draft'
    or new.approved_at is distinct from old.approved_at and old.approval_status <> 'draft' then
    raise exception 'show_revisions evidence fields are immutable';
  end if;

  if old.approval_status = 'draft'
    and new.approval_status = 'approved'
    and old.approved_by is null
    and old.approved_at is null
    and new.approved_by is not null
    and new.approved_at is not null then
    return new;
  end if;

  raise exception 'show_revisions only permits a draft to approved transition';
end;
$$;

drop trigger if exists show_revisions_append_only on show_revisions;
create trigger show_revisions_append_only
before update or delete on show_revisions
for each row execute function enforce_show_revision_evidence_mutation();
