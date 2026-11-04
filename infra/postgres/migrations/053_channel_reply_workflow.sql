create type channel_reply_status as enum ('draft', 'pending_approval', 'approved', 'sending', 'sent', 'failed', 'rejected');

alter table live_interactions
  add column if not exists channel_connection_id uuid references channel_connections(id) on delete restrict;

create index if not exists live_interactions_channel_connection_idx
  on live_interactions (tenant_id, channel_connection_id, created_at desc)
  where channel_connection_id is not null;

create table channel_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  interaction_id uuid not null references live_interactions(id) on delete restrict,
  channel_connection_id uuid not null references channel_connections(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 1000),
  body_sha256 char(64) not null,
  status channel_reply_status not null default 'draft',
  policy_action text not null check (policy_action in ('answer', 'handoff', 'refuse')),
  evidence_snapshot jsonb not null default '[]'::jsonb,
  product_version_id uuid references product_versions(id) on delete restrict,
  product_revision integer,
  created_by uuid not null references users(id) on delete restrict,
  edited_by uuid references users(id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references users(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references users(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text,
  sent_at timestamptz,
  provider_message_id text,
  outbox_event_id uuid references outbox_events(id) on delete restrict,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (interaction_id),
  unique (outbox_event_id)
);

create index channel_reply_drafts_tenant_run_status_idx
  on channel_reply_drafts (tenant_id, live_run_id, status, created_at desc);

alter table channel_reply_drafts enable row level security;
alter table channel_reply_drafts force row level security;
create policy tenant_isolation_channel_reply_drafts
  on channel_reply_drafts
  using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function enforce_channel_reply_draft_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'channel reply drafts are immutable';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft'
      or new.body_sha256 <> encode(digest(new.body, 'sha256'), 'hex')
      or new.submitted_at is not null
      or new.approved_by is not null
      or new.approved_at is not null
      or new.rejected_by is not null
      or new.rejected_at is not null
      or new.sent_at is not null
      or new.provider_message_id is not null
      or new.outbox_event_id is not null
      or new.failure_reason is not null then
      raise exception 'channel reply drafts must start as unsubmitted drafts with a matching body hash';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.tenant_id is distinct from old.tenant_id
    or new.live_run_id is distinct from old.live_run_id
    or new.interaction_id is distinct from old.interaction_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at then
    raise exception 'channel reply identity is immutable';
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if new.submitted_at is not null
      or new.approved_by is not null
      or new.approved_at is not null
      or new.rejected_by is not null
      or new.rejected_at is not null
      or new.sent_at is not null
      or new.provider_message_id is not null
      or new.outbox_event_id is not null
      or new.failure_reason is not null
      or new.edited_by is null
      or new.body_sha256 <> encode(digest(new.body, 'sha256'), 'hex') then
      raise exception 'draft channel reply mutation is invalid';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'pending_approval'
    and new.body is not distinct from old.body
    and new.body_sha256 is not distinct from old.body_sha256
    and new.channel_connection_id is not distinct from old.channel_connection_id
    and new.policy_action is not distinct from old.policy_action
    and new.evidence_snapshot is not distinct from old.evidence_snapshot
    and new.product_version_id is not distinct from old.product_version_id
    and new.product_revision is not distinct from old.product_revision
    and new.submitted_at is not null
    and new.approved_by is null
    and new.approved_at is null
    and new.rejected_by is null
    and new.rejected_at is null
    and new.sent_at is null
    and new.provider_message_id is null
    and new.outbox_event_id is null
    and new.failure_reason is null then
    return new;
  end if;

  if old.status = 'pending_approval' and new.status in ('approved', 'rejected')
    and new.body is not distinct from old.body
    and new.body_sha256 is not distinct from old.body_sha256
    and new.channel_connection_id is not distinct from old.channel_connection_id
    and new.policy_action is not distinct from old.policy_action
    and new.evidence_snapshot is not distinct from old.evidence_snapshot
    and new.product_version_id is not distinct from old.product_version_id
    and new.product_revision is not distinct from old.product_revision
    and new.submitted_at is not distinct from old.submitted_at
    and ((new.status = 'approved' and new.approved_by is not null and new.approved_at is not null and new.rejected_by is null and new.rejected_at is null and new.rejection_reason is null)
      or (new.status = 'rejected' and new.rejected_by is not null and new.rejected_at is not null and new.rejection_reason is not null and new.approved_by is null and new.approved_at is null))
    and new.sent_at is null
    and new.provider_message_id is null
    and new.outbox_event_id is null
    and new.failure_reason is null then
    return new;
  end if;

  if old.status = 'approved' and new.status = 'sending'
    and new.body is not distinct from old.body
    and new.body_sha256 is not distinct from old.body_sha256
    and new.channel_connection_id is not distinct from old.channel_connection_id
    and new.policy_action is not distinct from old.policy_action
    and new.evidence_snapshot is not distinct from old.evidence_snapshot
    and new.product_version_id is not distinct from old.product_version_id
    and new.product_revision is not distinct from old.product_revision
    and new.approved_by is not distinct from old.approved_by
    and new.approved_at is not distinct from old.approved_at
    and new.outbox_event_id is not null then
    return new;
  end if;

  if old.status = 'sending' and new.status in ('sent', 'failed')
    and new.body is not distinct from old.body
    and new.body_sha256 is not distinct from old.body_sha256
    and new.channel_connection_id is not distinct from old.channel_connection_id
    and new.policy_action is not distinct from old.policy_action
    and new.evidence_snapshot is not distinct from old.evidence_snapshot
    and new.product_version_id is not distinct from old.product_version_id
    and new.product_revision is not distinct from old.product_revision
    and new.approved_by is not distinct from old.approved_by
    and new.approved_at is not distinct from old.approved_at
    and new.outbox_event_id is not distinct from old.outbox_event_id
    and ((new.status = 'sent' and new.sent_at is not null and new.provider_message_id is not null and new.failure_reason is null)
      or (new.status = 'failed' and new.failure_reason is not null and new.sent_at is null and new.provider_message_id is null)) then
    return new;
  end if;

  if old.status = 'failed' and new.status = 'approved'
    and new.body is not distinct from old.body
    and new.body_sha256 is not distinct from old.body_sha256
    and new.channel_connection_id is not distinct from old.channel_connection_id
    and new.policy_action is not distinct from old.policy_action
    and new.evidence_snapshot is not distinct from old.evidence_snapshot
    and new.product_version_id is not distinct from old.product_version_id
    and new.product_revision is not distinct from old.product_revision
    and new.submitted_at is not distinct from old.submitted_at
    and new.approved_by is not distinct from old.approved_by
    and new.approved_at is not distinct from old.approved_at
    and new.rejected_by is null
    and new.rejected_at is null
    and new.rejection_reason is null
    and new.sent_at is null
    and new.provider_message_id is null
    and new.outbox_event_id is null
    and new.failure_reason is null then
    return new;
  end if;

  raise exception 'channel reply transition is not allowed';
end;
$$;

create trigger channel_reply_drafts_governed_mutation
before insert or update or delete on channel_reply_drafts
for each row execute function enforce_channel_reply_draft_mutation();
