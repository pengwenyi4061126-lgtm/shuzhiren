create table recording_evidence (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  live_run_id uuid not null references live_runs(id) on delete restrict,
  object_key text not null check (char_length(object_key) between 1 and 512),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes >= 0),
  duration_seconds integer not null check (duration_seconds >= 0),
  started_at timestamptz,
  ended_at timestamptz,
  recorded_at timestamptz not null default now(),
  retention_until date,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, object_key),
  check (ended_at is null or started_at is null or ended_at >= started_at)
);

create index recording_evidence_tenant_run_recorded_idx
  on recording_evidence (tenant_id, live_run_id, recorded_at desc);

alter table recording_evidence enable row level security;
alter table recording_evidence force row level security;
create policy tenant_isolation_recording_evidence on recording_evidence
  using (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_recording_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'recording_evidence is append-only';
end;
$$;

create trigger recording_evidence_append_only
before update or delete on recording_evidence
for each row execute function reject_recording_evidence_mutation();
