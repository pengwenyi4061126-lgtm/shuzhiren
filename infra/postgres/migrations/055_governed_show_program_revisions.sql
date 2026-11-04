create type show_program_change_status as enum ('draft', 'pending_approval', 'approved', 'rejected', 'applied');

create table show_program_change_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  source_revision_id uuid not null references show_revisions(id) on delete restrict,
  candidate_revision_id uuid not null references show_revisions(id) on delete restrict unique,
  status show_program_change_status not null default 'draft',
  source_program_sha256 text not null check (source_program_sha256 ~ '^[a-f0-9]{64}$'),
  proposed_program jsonb,
  proposed_program_sha256 text check (proposed_program_sha256 is null or proposed_program_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references users(id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references users(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references users(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) between 1 and 1000),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('pending_approval', 'approved', 'rejected', 'applied')) = (submitted_at is not null)),
  check ((status in ('approved', 'applied')) = (approved_at is not null and approved_by is not null)),
  check ((status = 'rejected') = (rejected_at is not null and rejected_by is not null and rejection_reason is not null)),
  check ((status = 'applied') = (applied_at is not null))
);

create unique index show_program_change_requests_one_active_run_idx
  on show_program_change_requests (live_run_id)
  where status in ('draft', 'pending_approval', 'approved');
create index show_program_change_requests_tenant_run_idx
  on show_program_change_requests (tenant_id, live_run_id, created_at desc);

alter table show_program_change_requests enable row level security;
alter table show_program_change_requests force row level security;
create policy tenant_isolation_show_program_change_requests on show_program_change_requests
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function enforce_show_program_change_request_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'show program change requests are immutable';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.proposed_program is not null or new.proposed_program_sha256 is not null
      or new.submitted_at is not null or new.approved_by is not null or new.approved_at is not null
      or new.rejected_by is not null or new.rejected_at is not null or new.rejection_reason is not null or new.applied_at is not null then
      raise exception 'show program change requests must begin as drafts';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
    or new.live_run_id is distinct from old.live_run_id or new.source_revision_id is distinct from old.source_revision_id
    or new.candidate_revision_id is distinct from old.candidate_revision_id
    or new.source_program_sha256 is distinct from old.source_program_sha256
    or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'show program change request evidence fields are immutable';
  end if;

  if old.status = 'draft' and new.status = 'pending_approval'
    and new.proposed_program is not null and new.proposed_program_sha256 is not null and new.submitted_at is not null
    and new.approved_by is null and new.approved_at is null and new.rejected_by is null
    and new.rejected_at is null and new.rejection_reason is null and new.applied_at is null then
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'pending_approval' and new.status = 'approved'
    and new.proposed_program is not distinct from old.proposed_program
    and new.proposed_program_sha256 is not distinct from old.proposed_program_sha256
    and new.submitted_at is not distinct from old.submitted_at
    and new.approved_by is not null and new.approved_by is distinct from old.created_by and new.approved_at is not null
    and new.rejected_by is null and new.rejected_at is null and new.rejection_reason is null and new.applied_at is null then
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'pending_approval' and new.status = 'rejected'
    and new.proposed_program is not distinct from old.proposed_program
    and new.proposed_program_sha256 is not distinct from old.proposed_program_sha256
    and new.submitted_at is not distinct from old.submitted_at
    and new.approved_by is null and new.approved_at is null
    and new.rejected_by is not null and new.rejected_by is distinct from old.created_by and new.rejected_at is not null and new.rejection_reason is not null
    and new.applied_at is null then
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'approved' and new.status = 'applied'
    and new.proposed_program is not distinct from old.proposed_program
    and new.proposed_program_sha256 is not distinct from old.proposed_program_sha256
    and new.submitted_at is not distinct from old.submitted_at
    and new.approved_by is not distinct from old.approved_by and new.approved_at is not distinct from old.approved_at
    and new.rejected_by is null and new.rejected_at is null and new.rejection_reason is null and new.applied_at is not null then
    new.updated_at := now();
    return new;
  end if;

  raise exception 'show program change request transition is not permitted';
end;
$$;

create trigger show_program_change_requests_governed_mutation
before insert or update or delete on show_program_change_requests
for each row execute function enforce_show_program_change_request_mutation();

create or replace function reject_show_revision_binding_mutation()
returns trigger
language plpgsql
as $$
declare
  revision_id uuid;
begin
  revision_id := case when tg_op = 'DELETE' then old.show_revision_id else new.show_revision_id end;
  if exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id) then
    raise exception 'Candidate show revision bindings are immutable';
  end if;
  if tg_op <> 'INSERT' or exists (select 1 from live_runs where show_revision_id = revision_id) then
    raise exception 'Frozen show revision bindings are immutable';
  end if;
  return new;
end;
$$;

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
    and not exists (select 1 from show_program_change_requests where candidate_revision_id = revision_id) then
    return new;
  end if;
  raise exception 'Show program segments are editable only in an attached DRAFT run or draft revision request';
end;
$$;

drop trigger if exists show_revision_segments_immutable on show_revision_segments;
create trigger show_revision_segments_immutable
before insert or update or delete on show_revision_segments
for each row execute function reject_show_revision_segment_mutation();

create or replace function enforce_live_run_show_revision_rebind()
returns trigger
language plpgsql
as $$
declare
  source_show_id uuid;
  candidate_show_id uuid;
begin
  if new.show_revision_id is not distinct from old.show_revision_id then return new; end if;
  if old.state not in ('APPROVED', 'PREFLIGHT') or new.state <> 'APPROVED' then
    raise exception 'Show revision binding can change only before arming and returns the run to APPROVED';
  end if;
  select show_id into source_show_id from show_revisions where id = old.show_revision_id;
  select show_id into candidate_show_id from show_revisions where id = new.show_revision_id and approval_status = 'approved';
  if candidate_show_id is null or candidate_show_id is distinct from source_show_id then
    raise exception 'Replacement revision must be an approved revision of the same show';
  end if;
  if not exists (
    select 1 from show_program_change_requests
    where live_run_id = old.id and source_revision_id = old.show_revision_id
      and candidate_revision_id = new.show_revision_id and status = 'approved'
  ) then
    raise exception 'Replacement revision requires an approved governed change request';
  end if;
  if exists (select 1 from live_runs where show_revision_id = new.show_revision_id and id <> old.id) then
    raise exception 'Replacement revision is already bound to another live run';
  end if;
  return new;
end;
$$;

create trigger live_runs_governed_show_revision_rebind
before update of show_revision_id on live_runs
for each row execute function enforce_live_run_show_revision_rebind();
