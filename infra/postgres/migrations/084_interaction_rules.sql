-- Live interaction rules (P0): approved, tenant-scoped rules that answer viewer events (entering the room,
-- following, gifts, keywords in comments) and timers (timed announcements, idle prompts) with a templated line.
-- The runtime worker evaluates them and queues the line on the existing paths only: a speech.dispatch outbox
-- event bound to the run's frozen voice and product version, or a channel reply draft that still needs human
-- approval. interaction_rule_firings records every decision once per (run, rule, trigger) for audit.
--
-- Foreign keys between tenant tables use the composite (tenant_id, ...) form directly (078).

-- Channel events beyond comments. viewer_ref is a SHA-256 of the channel connection and the platform's viewer
-- id (the raw id is not stored); viewer_nickname is the platform display name, sanitized again before speech.
-- rules_evaluated_at is set by the runtime worker once the interaction rules have seen the interaction.
alter table live_interactions
  add column interaction_kind text not null default 'comment',
  add column viewer_ref text,
  add column viewer_nickname text,
  add column gift_value_cents bigint,
  add column rules_evaluated_at timestamptz,
  add constraint live_interactions_interaction_kind_check check (interaction_kind in ('comment', 'viewer_enter', 'follow', 'gift')),
  add constraint live_interactions_viewer_ref_check check (viewer_ref is null or viewer_ref ~ '^[0-9a-f]{64}$'),
  add constraint live_interactions_viewer_nickname_check check (viewer_nickname is null or char_length(viewer_nickname) between 1 and 64),
  add constraint live_interactions_gift_value_check check ((interaction_kind = 'gift') = (gift_value_cents is not null) and (gift_value_cents is null or gift_value_cents between 0 and 1000000000000));
create index live_interactions_rule_queue_idx on live_interactions (tenant_id, live_run_id, created_at);

-- The rule evaluator spaces automatic speech against every speech.dispatch of a run, manual ones included.
create index outbox_events_speech_run_created_idx on outbox_events (tenant_id, aggregate_id, created_at desc) where event_type = 'speech.dispatch';

create type interaction_rule_trigger as enum ('viewer_enter', 'follow', 'gift', 'keyword', 'timed', 'idle_comment');
create type interaction_rule_action as enum ('speak', 'reply_draft');
create type interaction_rule_approval as enum ('pending', 'approved');

create table interaction_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  -- null: every live run of the tenant; otherwise only this live run (场次).
  live_run_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  trigger_type interaction_rule_trigger not null,
  -- keyword: {"keywords": [...]}; gift: {"minGiftValueCents": n}; other triggers: {}.
  match_config jsonb not null default '{}'::jsonb check (jsonb_typeof(match_config) = 'object'),
  -- One to ten template strings with the slots {nickname}, {product_name} and {price}.
  templates jsonb not null check (jsonb_typeof(templates) = 'array' and jsonb_array_length(templates) between 1 and 10),
  action interaction_rule_action not null,
  cooldown_seconds integer not null default 60 check (cooldown_seconds between 0 and 86400),
  interval_seconds integer check (interval_seconds is null or interval_seconds between 60 and 86400),
  priority integer not null default 100 check (priority between 0 and 1000),
  enabled boolean not null default true,
  -- Rules created by "create default rules" carry their key, which makes that action idempotent per tenant.
  default_key text check (default_key is null or default_key in ('welcome', 'follow_thanks', 'gift_thanks', 'timed_product', 'ai_disclosure')),
  approval_status interaction_rule_approval not null default 'pending',
  approved_by uuid references users(id) on delete restrict,
  approved_at timestamptz,
  created_by uuid not null references users(id) on delete restrict,
  updated_by uuid references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, live_run_id) references live_runs (tenant_id, id),
  check ((approval_status = 'approved') = (approved_by is not null and approved_at is not null)),
  check ((approval_status = 'approved') or (approved_by is null and approved_at is null)),
  check ((trigger_type in ('timed', 'idle_comment')) = (interval_seconds is not null)),
  -- A reply draft answers a channel interaction; timers have none.
  check (action = 'speak' or trigger_type not in ('timed', 'idle_comment')),
  -- The spoken AI identity disclosure (AIGC labelling): tenant-wide, timed, spoken, every 1 to 30 minutes.
  check (default_key is distinct from 'ai_disclosure' or (trigger_type = 'timed' and action = 'speak' and live_run_id is null and interval_seconds between 60 and 1800))
);
create unique index interaction_rules_tenant_default_key_idx on interaction_rules (tenant_id, default_key) where default_key is not null;
create index interaction_rules_tenant_active_idx on interaction_rules (tenant_id, live_run_id) where enabled and approval_status = 'approved';
alter table interaction_rules enable row level security;
alter table interaction_rules force row level security;
create policy tenant_isolation_interaction_rules on interaction_rules using (tenant_id::text = current_setting('app.tenant_id', true));

-- Rules are never deleted (firings reference them); they are disabled. A change of what a rule says or answers
-- returns it to pending approval. The AI identity disclosure stays enabled and only its interval may change.
create or replace function enforce_interaction_rule_mutation()
returns trigger
language plpgsql
as $$
declare
  content_changed boolean;
begin
  if TG_OP = 'DELETE' then
    raise exception 'interaction rules are retained for audit; disable the rule instead';
  end if;
  if TG_OP = 'INSERT' then
    if new.approval_status <> 'pending' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'interaction rules must be created pending approval';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.default_key is distinct from old.default_key
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'interaction rule identity is immutable';
  end if;
  content_changed := new.trigger_type is distinct from old.trigger_type
    or new.match_config is distinct from old.match_config
    or new.templates is distinct from old.templates
    or new.action is distinct from old.action
    or new.live_run_id is distinct from old.live_run_id;
  if old.default_key = 'ai_disclosure' then
    if new.enabled is distinct from true then
      raise exception 'the AI identity disclosure rule cannot be disabled';
    end if;
    if content_changed
      or new.name is distinct from old.name
      or new.cooldown_seconds is distinct from old.cooldown_seconds
      or new.priority is distinct from old.priority then
      raise exception 'only the interval of the AI identity disclosure rule can change';
    end if;
  end if;
  if content_changed and (new.approval_status <> 'pending' or new.approved_by is not null or new.approved_at is not null) then
    raise exception 'a changed interaction rule must return to pending approval';
  end if;
  if old.approval_status = 'approved' and new.approval_status = 'approved'
    and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'interaction rule approval evidence is immutable';
  end if;
  return new;
end;
$$;
create trigger interaction_rules_governed_mutation
before insert or update or delete on interaction_rules
for each row execute function enforce_interaction_rule_mutation();

-- One row per (run, rule, trigger): the interaction it answered or the timer slot it filled, the template and
-- the hash of the rendered text, and the outcome. The unique key makes evaluation idempotent across workers;
-- a second index stops two successful firings of one rule in the same cooldown window.
create table interaction_rule_firings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  rule_id uuid not null,
  live_run_id uuid not null,
  interaction_id uuid,
  trigger_key text not null check (trigger_key ~ '^(interaction:[0-9a-f-]{36}|slot:[0-9]{1,15}|idle:[0-9]{1,15})$'),
  viewer_ref text check (viewer_ref is null or viewer_ref ~ '^[0-9a-f]{64}$'),
  template_index integer check (template_index is null or template_index between 0 and 9),
  rendered_text_sha256 char(64) check (rendered_text_sha256 is null or rendered_text_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('speech_queued', 'reply_drafted', 'policy_blocked', 'suppressed', 'unavailable')),
  outcome_reason text check (outcome_reason is null or char_length(outcome_reason) between 1 and 300),
  cooldown_bucket bigint,
  outbox_event_id uuid,
  product_version_id uuid,
  product_revision integer,
  created_at timestamptz not null default now(),
  unique (tenant_id, live_run_id, rule_id, trigger_key),
  foreign key (tenant_id, rule_id) references interaction_rules (tenant_id, id),
  foreign key (tenant_id, live_run_id) references live_runs (tenant_id, id),
  foreign key (tenant_id, interaction_id) references live_interactions (tenant_id, id),
  foreign key (tenant_id, outbox_event_id) references outbox_events (tenant_id, id),
  foreign key (tenant_id, product_version_id) references product_versions (tenant_id, id),
  -- A blocked line keeps its hash too, so the audit shows which rendering the policy refused.
  check (outcome not in ('speech_queued', 'reply_drafted') or (rendered_text_sha256 is not null and template_index is not null)),
  check (rendered_text_sha256 is null or template_index is not null),
  check ((outcome = 'speech_queued') = (outbox_event_id is not null)),
  check (outcome in ('speech_queued', 'reply_drafted') or cooldown_bucket is null)
);
create unique index interaction_rule_firings_cooldown_idx on interaction_rule_firings (tenant_id, live_run_id, rule_id, cooldown_bucket)
  where cooldown_bucket is not null;
create index interaction_rule_firings_run_created_idx on interaction_rule_firings (tenant_id, live_run_id, created_at desc);
create index interaction_rule_firings_viewer_idx on interaction_rule_firings (tenant_id, live_run_id, viewer_ref, created_at desc)
  where viewer_ref is not null and outcome in ('speech_queued', 'reply_drafted');
alter table interaction_rule_firings enable row level security;
alter table interaction_rule_firings force row level security;
create policy tenant_isolation_interaction_rule_firings on interaction_rule_firings using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_interaction_rule_firing_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'interaction rule firings are append-only';
end;
$$;
create trigger interaction_rule_firings_append_only
before update or delete on interaction_rule_firings
for each row execute function reject_interaction_rule_firing_mutation();

-- The runtime worker may not read products or product facts (service-principals.sql). This function returns
-- only what a rule may say about the run's frozen primary product version: its id, revision, product name,
-- price and the source and validity fields the worker checks for freshness. Like runtime_worker_actor it runs
-- as its owner and refuses any tenant but the one of the caller's transaction.
create or replace function interaction_rule_product_context(requested_tenant_id uuid, requested_run_id uuid)
returns table (product_version_id uuid, product_revision integer, product_name text, price_cent bigint, source_ref text, source_synced_at text, valid_from text, valid_until text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if requested_tenant_id is null or current_setting('app.tenant_id', true) is distinct from requested_tenant_id::text then
    raise exception 'interaction rule product context requires its active tenant transaction';
  end if;
  return query
    select pv.id, pv.revision, p.name::text,
      case when (pv.facts ->> 'priceCent') ~ '^[0-9]{1,15}$' then (pv.facts ->> 'priceCent')::bigint end,
      pv.facts ->> 'sourceRef', pv.facts ->> 'sourceSyncedAt', pv.facts ->> 'validFrom', pv.facts ->> 'validUntil'
    from live_runs r
    join show_revision_product_versions binding
      on binding.tenant_id = r.tenant_id and binding.show_revision_id = r.show_revision_id and binding.slot_key = 'primary'
    join product_versions pv on pv.tenant_id = binding.tenant_id and pv.id = binding.product_version_id
    join products p on p.tenant_id = pv.tenant_id and p.id = pv.product_id
    where r.tenant_id = requested_tenant_id
      and r.id = requested_run_id
      and r.product_version_id = binding.product_version_id
      and pv.approval_status = 'approved';
end;
$$;
revoke all on function interaction_rule_product_context(uuid, uuid) from public;
