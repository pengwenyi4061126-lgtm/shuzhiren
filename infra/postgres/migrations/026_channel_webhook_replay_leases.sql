alter type channel_webhook_replay_state add value if not exists 'delivering';

alter table channel_webhook_replays
  add column if not exists lease_expires_at timestamptz;

create index if not exists channel_webhook_replays_lease_idx
  on channel_webhook_replays (tenant_id, state, lease_expires_at);
