-- Prohibited terms (P1): tenant-level changes to the built-in sample lexicon (apps/console/lib/shared/prohibited-terms-builtin.mjs)
-- and the lexicon frozen into each approved show revision.
--
-- tenant_prohibited_terms holds one row per tenant term: a custom term, or an override of one built-in term (stop
-- using it, or change its severity or replacement suggestions). The row carries the APPROVED effective values; a
-- change is requested as a row of tenant_prohibited_term_revisions and reaches the term row only after that revision
-- is approved. Loosening changes (stopping a built-in term, retiring a custom term, lowering block to warn) need a
-- written reason and an approver who is not the requester. Terms are never deleted.
--
-- show_revision_prohibited_term_snapshots is written once, inside the transaction that approves a show revision, and
-- the trigger on show_revisions below refuses the approval of a revision that has no snapshot. This is why the
-- migration and the console code that writes the snapshot ship in the same commit.
-- Foreign keys between tenant tables use the composite (tenant_id, ...) form directly (078).

create table tenant_prohibited_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  kind text not null check (kind in ('custom', 'builtin_override')),
  builtin_term_id text check (builtin_term_id is null or builtin_term_id ~ '^builtin:[a-z_]{1,20}:[0-9]{3}$'),
  term text check (term is null or char_length(btrim(term)) between 1 and 30),
  normalized_term text check (normalized_term is null or char_length(normalized_term) between 1 and 30),
  category text not null check (category in ('extreme', 'medical', 'false_claim', 'offsite_trade', 'custom')),
  -- The approved effective values. approved_revision is null until the first revision is approved, and a term
  -- without an approved revision has no effect on any text.
  approved_revision integer,
  severity text check (severity is null or severity in ('block', 'warn')),
  suggestions jsonb check (suggestions is null or (jsonb_typeof(suggestions) = 'array' and jsonb_array_length(suggestions) <= 5)),
  disabled boolean not null default false,
  active boolean not null default true,
  approved_at timestamptz,
  created_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint tenant_prohibited_terms_custom_shape_check check ((kind = 'custom') = (term is not null and normalized_term is not null and builtin_term_id is null)),
  constraint tenant_prohibited_terms_override_shape_check check ((kind = 'builtin_override') = (builtin_term_id is not null and term is null)),
  constraint tenant_prohibited_terms_custom_enabled_check check (kind = 'builtin_override' or disabled = false),
  constraint tenant_prohibited_terms_approved_pair_check check ((approved_revision is null) = (approved_at is null))
);
create unique index tenant_prohibited_terms_custom_idx on tenant_prohibited_terms (tenant_id, normalized_term) where kind = 'custom';
create unique index tenant_prohibited_terms_override_idx on tenant_prohibited_terms (tenant_id, builtin_term_id) where kind = 'builtin_override';

-- One row per requested change of a term. loosening says that the change lets text through that the previously
-- approved values blocked; such a change carries a reason of 10 to 500 characters and cannot be approved by its requester.
create table tenant_prohibited_term_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  term_id uuid not null,
  revision integer not null check (revision >= 1),
  severity text not null check (severity in ('block', 'warn')),
  suggestions jsonb not null check (jsonb_typeof(suggestions) = 'array' and jsonb_array_length(suggestions) <= 5),
  disabled boolean not null,
  active boolean not null,
  loosening boolean not null,
  reason text check (reason is null or char_length(btrim(reason)) between 10 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid not null references users(id) on delete restrict,
  decided_by uuid references users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, term_id, revision),
  foreign key (tenant_id, term_id) references tenant_prohibited_terms (tenant_id, id),
  constraint tenant_prohibited_term_revisions_loosening_reason_check check (not loosening or reason is not null),
  constraint tenant_prohibited_term_revisions_decision_state_check check ((status = 'pending') = (decided_by is null and decided_at is null)),
  constraint tenant_prohibited_term_revisions_loosening_approver_check check (status <> 'approved' or not loosening or decided_by is distinct from requested_by)
);
create unique index tenant_prohibited_term_revisions_pending_idx on tenant_prohibited_term_revisions (tenant_id, term_id) where status = 'pending';

-- The lexicon (compiled terms, as the console computed it) that was in force when the show revision was approved.
-- lexicon_sha256 is computed by the application over the canonical form of lexicon; the trigger does not recompute it
-- because jsonb does not keep key order.
create table show_revision_prohibited_term_snapshots (
  tenant_id uuid not null references tenants(id) on delete restrict,
  show_revision_id uuid not null,
  builtin_version text not null check (char_length(builtin_version) between 1 and 40),
  lexicon jsonb not null check (jsonb_typeof(lexicon) = 'array'),
  lexicon_sha256 char(64) not null check (lexicon_sha256 ~ '^[0-9a-f]{64}$'),
  term_count integer not null check (term_count >= 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, show_revision_id),
  foreign key (tenant_id, show_revision_id) references show_revisions (tenant_id, id)
);

alter table tenant_prohibited_terms enable row level security;
alter table tenant_prohibited_terms force row level security;
create policy tenant_isolation_tenant_prohibited_terms on tenant_prohibited_terms using (tenant_id::text = current_setting('app.tenant_id', true));
alter table tenant_prohibited_term_revisions enable row level security;
alter table tenant_prohibited_term_revisions force row level security;
create policy tenant_isolation_tenant_prohibited_term_revisions on tenant_prohibited_term_revisions using (tenant_id::text = current_setting('app.tenant_id', true));
alter table show_revision_prohibited_term_snapshots enable row level security;
alter table show_revision_prohibited_term_snapshots force row level security;
create policy tenant_isolation_show_revision_prohibited_term_snapshots on show_revision_prohibited_term_snapshots using (tenant_id::text = current_setting('app.tenant_id', true));

-- A term row is never deleted and its identity never changes. A new row has no effect: it carries no approved
-- values. The approved values (approved_revision, severity, suggestions, disabled, active, approved_at) change
-- only together, to the values of an approved revision of this term whose number is higher than the one in force.
create or replace function enforce_tenant_prohibited_term_mutation()
returns trigger
language plpgsql
as $$
declare
  approved tenant_prohibited_term_revisions%rowtype;
begin
  if TG_OP = 'DELETE' then
    raise exception 'prohibited terms are retained for audit; request a change that turns the term off instead';
  end if;
  if TG_OP = 'INSERT' then
    if new.approved_revision is not null or new.approved_at is not null or new.severity is not null
      or new.suggestions is not null or new.disabled or not new.active then
      raise exception 'a prohibited term is created without approved values; they come from an approved revision';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.kind is distinct from old.kind
    or new.builtin_term_id is distinct from old.builtin_term_id
    or new.term is distinct from old.term
    or new.normalized_term is distinct from old.normalized_term
    or new.category is distinct from old.category
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'prohibited term identity is immutable';
  end if;
  if new.approved_revision is distinct from old.approved_revision
    or new.severity is distinct from old.severity
    or new.suggestions is distinct from old.suggestions
    or new.disabled is distinct from old.disabled
    or new.active is distinct from old.active
    or new.approved_at is distinct from old.approved_at then
    if new.approved_revision is null or (old.approved_revision is not null and new.approved_revision <= old.approved_revision) then
      raise exception 'the approved revision of a prohibited term must increase';
    end if;
    select * into approved from tenant_prohibited_term_revisions r
    where r.tenant_id = new.tenant_id and r.term_id = new.id and r.revision = new.approved_revision and r.status = 'approved';
    if not found
      or new.severity is distinct from approved.severity
      or new.suggestions is distinct from approved.suggestions
      or new.disabled is distinct from approved.disabled
      or new.active is distinct from approved.active
      or new.approved_at is distinct from approved.decided_at then
      raise exception 'the approved values of a prohibited term must equal those of an approved revision';
    end if;
  end if;
  return new;
end;
$$;
create trigger tenant_prohibited_terms_governed_mutation
before insert or update or delete on tenant_prohibited_terms
for each row execute function enforce_tenant_prohibited_term_mutation();

-- A revision is created pending with the next number of its term and is only ever decided. Turning a term off, or
-- lowering its approved severity from block to warn, loosens the lexicon and must say so (and then needs a reason
-- and a different approver, by the table constraints).
create or replace function enforce_tenant_prohibited_term_revision_mutation()
returns trigger
language plpgsql
as $$
declare
  expected_revision integer;
  term_row tenant_prohibited_terms%rowtype;
begin
  if TG_OP = 'DELETE' then
    raise exception 'prohibited term revisions are retained for audit';
  end if;
  if TG_OP = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'a prohibited term revision is created pending approval';
    end if;
    select coalesce(max(r.revision), 0) + 1 into expected_revision
    from tenant_prohibited_term_revisions r where r.tenant_id = new.tenant_id and r.term_id = new.term_id;
    if new.revision is distinct from expected_revision then
      raise exception 'a prohibited term revision must use the next revision number of its term';
    end if;
    select * into term_row from tenant_prohibited_terms t where t.tenant_id = new.tenant_id and t.id = new.term_id;
    if (new.disabled or not new.active or (term_row.severity = 'block' and new.severity = 'warn')) and not new.loosening then
      raise exception 'a revision that turns a prohibited term off or lowers its severity is a loosening change';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.term_id is distinct from old.term_id
    or new.revision is distinct from old.revision
    or new.severity is distinct from old.severity
    or new.suggestions is distinct from old.suggestions
    or new.disabled is distinct from old.disabled
    or new.active is distinct from old.active
    or new.loosening is distinct from old.loosening
    or new.reason is distinct from old.reason
    or new.requested_by is distinct from old.requested_by
    or new.created_at is distinct from old.created_at then
    raise exception 'prohibited term revision content is immutable';
  end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected') then
    raise exception 'a prohibited term revision can only be decided once, from pending to approved or rejected';
  end if;
  if new.decided_by is null or new.decided_at is null then
    raise exception 'a decided prohibited term revision records who decided it and when';
  end if;
  return new;
end;
$$;
create trigger tenant_prohibited_term_revisions_governed_mutation
before insert or update or delete on tenant_prohibited_term_revisions
for each row execute function enforce_tenant_prohibited_term_revision_mutation();

-- The snapshot is written once, while the revision is still a draft (the approval transaction writes it just before
-- it approves the revision), and never changes afterwards.
create or replace function enforce_show_revision_prohibited_term_snapshot()
returns trigger
language plpgsql
as $$
declare
  revision_status text;
begin
  if TG_OP = 'UPDATE' or TG_OP = 'DELETE' then
    raise exception 'show revision prohibited term snapshots are append-only';
  end if;
  select sr.approval_status::text into revision_status from show_revisions sr where sr.tenant_id = new.tenant_id and sr.id = new.show_revision_id;
  if revision_status is distinct from 'draft' then
    raise exception 'a prohibited term snapshot can only be written while the show revision is a draft';
  end if;
  return new;
end;
$$;
create trigger show_revision_prohibited_term_snapshots_governed
before insert or update or delete on show_revision_prohibited_term_snapshots
for each row execute function enforce_show_revision_prohibited_term_snapshot();

-- A show revision becomes approved only with the lexicon it was approved against.
create or replace function require_lexicon_snapshot_for_program_approval()
returns trigger
language plpgsql
as $$
begin
  if new.approval_status = 'approved' and old.approval_status is distinct from 'approved'
    and not exists (
      select 1 from show_revision_prohibited_term_snapshots s
      where s.tenant_id = new.tenant_id and s.show_revision_id = new.id
    ) then
    raise exception 'Approved program revisions require a frozen prohibited-term lexicon snapshot';
  end if;
  return new;
end;
$$;
create trigger show_revisions_require_lexicon_snapshot
before update of approval_status on show_revisions
for each row execute function require_lexicon_snapshot_for_program_approval();
