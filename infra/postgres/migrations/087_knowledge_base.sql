-- Knowledge base (P1): tenant-wide question and answer entries that a "faq" interaction rule (086) uses to answer
-- viewer questions. An entry is written by an operator, becomes effective only through an approval snapshot, and
-- falls back to pending approval whenever its content changes. Entries are never deleted: they are retired.
-- Every answer the worker gives names the approval snapshot it used (interaction_rule_firings.knowledge_approval_id),
-- so the text of the answer that was given stays provable after the entry changes.
--
-- Entries are not frozen per show revision: an approved entry is effective for every run of the tenant, the same
-- as an approved interaction rule (084).
-- Foreign keys between tenant tables use the composite (tenant_id, ...) form directly (078).

-- Plain-text document imports. Only the import record is kept here; its chunks become pending "document_chunk"
-- entries that need the same approval as any other entry.
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  -- evidence:// or urn: reference of the source; the console validates the format.
  source_ref text not null check (char_length(source_ref) between 1 and 300),
  body text not null check (char_length(body) between 1 and 50000),
  body_sha256 char(64) not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  chunk_count integer not null check (chunk_count between 0 and 200),
  created_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  kind text not null check (kind in ('faq', 'document_chunk')),
  question text not null check (char_length(btrim(question)) between 1 and 200),
  alias_questions jsonb not null default '[]'::jsonb check (jsonb_typeof(alias_questions) = 'array' and jsonb_array_length(alias_questions) <= 5),
  answer text not null check (char_length(btrim(answer)) between 1 and 300),
  keywords jsonb not null default '[]'::jsonb check (jsonb_typeof(keywords) = 'array' and jsonb_array_length(keywords) <= 20),
  -- null: answers questions of every product; otherwise only runs whose frozen product version belongs to it.
  product_id uuid,
  -- Character bigrams and keywords of question, aliases, keywords and answer; the console computes them.
  search_terms text[] not null check (cardinality(search_terms) between 1 and 2000),
  revision integer not null default 1 check (revision >= 1),
  status text not null default 'pending' check (status in ('pending', 'approved', 'retired')),
  approved_approval_id uuid,
  source_document_id uuid,
  created_by uuid not null references users(id) on delete restrict,
  updated_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, source_document_id) references knowledge_documents (tenant_id, id),
  check ((status = 'approved') = (approved_approval_id is not null)),
  check ((status = 'retired') = (retired_at is not null))
);

-- One row per approval: a copy of what the entry said when it was approved, the hash of the answer, and the
-- policy profile and prohibited-term list (lexicon) hash the approval check ran against.
create table knowledge_entry_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  entry_id uuid not null,
  revision integer not null,
  question text not null,
  alias_questions jsonb not null,
  answer text not null,
  keywords jsonb not null,
  search_terms text[] not null,
  product_id uuid,
  answer_sha256 char(64) not null check (answer_sha256 ~ '^[0-9a-f]{64}$'),
  policy_profile_id uuid,
  lexicon_sha256 char(64) not null check (lexicon_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null references users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, entry_id, revision),
  foreign key (tenant_id, entry_id) references knowledge_entries (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, policy_profile_id) references policy_profiles (tenant_id, id)
);
alter table knowledge_entries add foreign key (tenant_id, approved_approval_id) references knowledge_entry_approvals (tenant_id, id);
create index knowledge_entry_approvals_terms_idx on knowledge_entry_approvals using gin (search_terms);
create index knowledge_entries_tenant_status_idx on knowledge_entries (tenant_id, status, updated_at desc);

alter table knowledge_documents enable row level security;
alter table knowledge_documents force row level security;
create policy tenant_isolation_knowledge_documents on knowledge_documents using (tenant_id::text = current_setting('app.tenant_id', true));
alter table knowledge_entries enable row level security;
alter table knowledge_entries force row level security;
create policy tenant_isolation_knowledge_entries on knowledge_entries using (tenant_id::text = current_setting('app.tenant_id', true));
alter table knowledge_entry_approvals enable row level security;
alter table knowledge_entry_approvals force row level security;
create policy tenant_isolation_knowledge_entry_approvals on knowledge_entry_approvals using (tenant_id::text = current_setting('app.tenant_id', true));

-- A firing that answered from the knowledge base names the approval snapshot it used.
alter table interaction_rule_firings
  add column knowledge_approval_id uuid,
  add foreign key (tenant_id, knowledge_approval_id) references knowledge_entry_approvals (tenant_id, id);

-- 084 declared the default_key check inline on the column, so PostgreSQL named it interaction_rules_default_key_check
-- (<table>_<column>_check). The statement fails, and the migration rolls back, if that constraint does not exist.
-- faq_answer is the default rule that answers from the knowledge base: tenant-wide, trigger "faq". A faq rule
-- carries the lowest score a hit needs, in permille, in match_config.minScorePermille (an integer, 300 to 1000).
-- The score is read through a CASE so that a value that is not an integer fails the check instead of the cast.
alter table interaction_rules
  drop constraint interaction_rules_default_key_check,
  add constraint interaction_rules_default_key_check check (default_key is null or default_key in ('welcome', 'follow_thanks', 'gift_thanks', 'timed_product', 'ai_disclosure', 'faq_answer')),
  add constraint interaction_rules_faq_shape_check check (
    trigger_type <> 'faq' or (interval_seconds is null
      and jsonb_typeof(match_config -> 'minScorePermille') = 'number'
      and case when (match_config ->> 'minScorePermille') ~ '^[0-9]{1,4}$'
        then (match_config ->> 'minScorePermille')::integer between 300 and 1000
        else false end)),
  add constraint interaction_rules_faq_default_check check (default_key is distinct from 'faq_answer' or (trigger_type = 'faq' and live_run_id is null));

-- Entries are never deleted. Content (question, aliases, answer, keywords, product, search terms) can change only
-- on a pending entry or an approved one that goes back to pending, and every content change adds one to the
-- revision. An entry becomes approved only through the snapshot of its current revision, and a retired entry no
-- longer changes at all.
create or replace function enforce_knowledge_entry_mutation()
returns trigger
language plpgsql
as $$
declare
  content_changed boolean;
  snapshot knowledge_entry_approvals%rowtype;
begin
  if TG_OP = 'DELETE' then
    raise exception 'knowledge entries are retained for audit; retire the entry instead';
  end if;
  if TG_OP = 'INSERT' then
    if new.status <> 'pending' or new.revision <> 1 or new.approved_approval_id is not null then
      raise exception 'knowledge entries must be created pending approval at revision 1';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.kind is distinct from old.kind
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.source_document_id is distinct from old.source_document_id then
    raise exception 'knowledge entry identity is immutable';
  end if;
  if old.status = 'retired' then
    raise exception 'a retired knowledge entry cannot change';
  end if;
  content_changed := new.question is distinct from old.question
    or new.alias_questions is distinct from old.alias_questions
    or new.answer is distinct from old.answer
    or new.keywords is distinct from old.keywords
    or new.product_id is distinct from old.product_id
    or new.search_terms is distinct from old.search_terms;
  if content_changed then
    if new.status <> 'pending' or new.approved_approval_id is not null or new.revision <> old.revision + 1 then
      raise exception 'a changed knowledge entry must return to pending approval with the next revision';
    end if;
  else
    if new.revision <> old.revision then
      raise exception 'the revision of a knowledge entry changes only with its content';
    end if;
    if old.status = 'approved' and new.status = 'pending' then
      raise exception 'an approved knowledge entry returns to pending approval only when its content changes';
    end if;
  end if;
  if new.status = 'approved' and (old.status <> 'approved' or new.approved_approval_id is distinct from old.approved_approval_id) then
    select * into snapshot from knowledge_entry_approvals a
    where a.tenant_id = new.tenant_id and a.id = new.approved_approval_id;
    if not found
      or snapshot.entry_id <> new.id
      or snapshot.revision <> new.revision
      or snapshot.question is distinct from new.question
      or snapshot.alias_questions is distinct from new.alias_questions
      or snapshot.answer is distinct from new.answer
      or snapshot.keywords is distinct from new.keywords
      or snapshot.search_terms is distinct from new.search_terms
      or snapshot.product_id is distinct from new.product_id then
      raise exception 'an approved knowledge entry must match the approval snapshot of its current revision';
    end if;
  end if;
  return new;
end;
$$;
create trigger knowledge_entries_governed_mutation
before insert or update or delete on knowledge_entries
for each row execute function enforce_knowledge_entry_mutation();

-- The snapshot is the evidence of what was approved: it is append-only, and an insert must copy the entry's
-- pending content at its current revision and carry the true hash of the answer.
create or replace function enforce_knowledge_entry_approval_insert()
returns trigger
language plpgsql
as $$
declare
  entry knowledge_entries%rowtype;
begin
  if TG_OP = 'UPDATE' or TG_OP = 'DELETE' then
    raise exception 'knowledge entry approvals are append-only';
  end if;
  select * into entry from knowledge_entries e where e.tenant_id = new.tenant_id and e.id = new.entry_id;
  if not found then
    raise exception 'a knowledge entry approval needs an entry of the same tenant';
  end if;
  if entry.status <> 'pending' then
    raise exception 'only a pending knowledge entry can be approved';
  end if;
  if new.revision is distinct from entry.revision then
    raise exception 'a knowledge entry approval must use the current revision of the entry';
  end if;
  if new.question is distinct from entry.question
    or new.alias_questions is distinct from entry.alias_questions
    or new.answer is distinct from entry.answer
    or new.keywords is distinct from entry.keywords
    or new.search_terms is distinct from entry.search_terms
    or new.product_id is distinct from entry.product_id then
    raise exception 'a knowledge entry approval must copy the content of the entry';
  end if;
  if new.answer_sha256::text is distinct from encode(sha256(convert_to(new.answer, 'UTF8')), 'hex') then
    raise exception 'a knowledge entry approval hash does not match its answer';
  end if;
  return new;
end;
$$;
create trigger knowledge_entry_approvals_governed
before insert or update or delete on knowledge_entry_approvals
for each row execute function enforce_knowledge_entry_approval_insert();

create or replace function reject_knowledge_document_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'knowledge documents are append-only';
end;
$$;
create trigger knowledge_documents_append_only
before update or delete on knowledge_documents
for each row execute function reject_knowledge_document_mutation();

-- The runtime worker may not read knowledge entries, their approvals or products (service-principals.sql). This
-- function returns, for the worker's tenant transaction, the approved snapshots whose search terms share at least
-- one term with the question, limited to entries that answer every product or the product of the run's frozen
-- product version. Scoring happens in the worker. Like interaction_rule_product_context it runs as its owner and
-- refuses any tenant but the one of the caller's transaction.
create or replace function knowledge_answer_candidates(requested_tenant_id uuid, requested_run_id uuid, query_terms text[], max_rows integer)
returns table (approval_id uuid, entry_id uuid, revision integer, question text, alias_questions jsonb, answer text, keywords jsonb, search_terms text[], answer_sha256 text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if requested_tenant_id is null or current_setting('app.tenant_id', true) is distinct from requested_tenant_id::text then
    raise exception 'knowledge answer candidates require their active tenant transaction';
  end if;
  return query
    select a.id, a.entry_id, a.revision, a.question, a.alias_questions, a.answer, a.keywords, a.search_terms, a.answer_sha256::text
    from knowledge_entries e
    join knowledge_entry_approvals a on a.tenant_id = e.tenant_id and a.id = e.approved_approval_id
    where e.tenant_id = requested_tenant_id
      and e.status = 'approved'
      and a.search_terms && query_terms
      and (a.product_id is null or a.product_id = (
        select pv.product_id
        from live_runs r
        join product_versions pv on pv.tenant_id = r.tenant_id and pv.id = r.product_version_id
        where r.tenant_id = requested_tenant_id and r.id = requested_run_id))
    order by a.id
    limit greatest(1, least(coalesce(max_rows, 20), 50));
end;
$$;
revoke all on function knowledge_answer_candidates(uuid, uuid, text[], integer) from public;
