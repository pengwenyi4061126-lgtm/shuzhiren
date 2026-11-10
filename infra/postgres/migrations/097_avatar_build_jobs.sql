create type avatar_build_job_state as enum ('queued', 'running', 'preview_ready', 'failed', 'cancelled');

create table avatar_build_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  project_id uuid not null,
  project_revision integer not null check (project_revision > 0),
  source_asset_id uuid not null,
  source_checksum text not null check (source_checksum ~ '^sha256:[a-f0-9]{64}$'),
  source_object_version text not null check (source_object_version ~ '^[A-Za-z0-9._:-]{1,200}$'),
  source_bytes bigint not null check (source_bytes between 1 and 104857600),
  source_content_type text not null check (source_content_type in ('video/mp4', 'video/webm', 'video/quicktime')),
  source_evidence_ref text not null check (source_evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or source_evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'),
  status avatar_build_job_state not null default 'queued',
  progress integer not null default 0 check (progress between 0 and 100),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text check (worker_id is null or char_length(btrim(worker_id)) between 1 and 200),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_detail text check (failure_detail is null or char_length(failure_detail) <= 1000),
  created_by text not null check (char_length(btrim(created_by)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, project_id) references creation_projects (tenant_id, id) on delete restrict,
  foreign key (tenant_id, source_asset_id) references media_assets (tenant_id, id) on delete restrict,
  constraint avatar_build_jobs_lease_state_check check (
    (status = 'running' and lease_token is not null and lease_expires_at is not null and worker_id is not null)
    or (status <> 'running' and lease_token is null and lease_expires_at is null and worker_id is null)
  ),
  constraint avatar_build_jobs_completion_state_check check (
    (status in ('preview_ready', 'failed', 'cancelled') and finished_at is not null)
    or (status in ('queued', 'running') and finished_at is null)
  ),
  constraint avatar_build_jobs_failure_state_check check (
    (status = 'failed' and failure_code is not null)
    or (status <> 'failed' and failure_code is null and failure_detail is null)
  )
);

create index avatar_build_jobs_claim_idx
  on avatar_build_jobs (available_at, created_at)
  where status = 'queued';

create unique index avatar_build_jobs_one_active_source_idx
  on avatar_build_jobs (tenant_id, project_id, source_asset_id)
  where status in ('queued', 'running');
create index avatar_build_jobs_expired_lease_idx
  on avatar_build_jobs (lease_expires_at)
  where status = 'running';

create index avatar_build_jobs_project_created_idx
  on avatar_build_jobs (tenant_id, project_id, created_at desc);

alter table avatar_build_jobs enable row level security;
alter table avatar_build_jobs force row level security;
create policy tenant_isolation_avatar_build_jobs on avatar_build_jobs
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));