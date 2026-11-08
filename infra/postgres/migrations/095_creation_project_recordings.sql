create table creation_project_recordings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  project_id uuid not null,
  project_revision integer not null check (project_revision > 0),
  product_version_id uuid not null,
  script_sha256 text not null check (script_sha256 ~ '^[a-f0-9]{64}$'),
  script_snapshot text not null check (char_length(script_snapshot) between 1 and 12000),
  photo_asset_id uuid not null,
  voice_asset_id uuid,
  file_name text not null check (char_length(file_name) between 1 and 160),
  object_key text not null check (char_length(object_key) between 1 and 500),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 104857600),
  content_type text not null check (content_type = 'video/webm'),
  verified_object_version text not null check (verified_object_version ~ '^[A-Za-z0-9._:-]{1,200}$'),
  verification_evidence_ref text not null check (verification_evidence_ref ~ '^evidence://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' or verification_evidence_ref ~ '^urn:[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'),
  verified_at timestamptz not null,
  created_by text not null check (char_length(btrim(created_by)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (tenant_id, object_key),
  foreign key (tenant_id, project_id) references creation_projects (tenant_id, id) on delete restrict,
  foreign key (tenant_id, product_version_id) references product_versions (tenant_id, id) on delete restrict,
  foreign key (tenant_id, photo_asset_id) references media_assets (tenant_id, id) on delete restrict,
  foreign key (tenant_id, voice_asset_id) references media_assets (tenant_id, id) on delete restrict
);

create index creation_project_recordings_project_created_idx
  on creation_project_recordings (tenant_id, project_id, created_at desc);

alter table creation_project_recordings enable row level security;
alter table creation_project_recordings force row level security;
create policy tenant_isolation_creation_project_recordings on creation_project_recordings
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create function govern_creation_project_recording_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $body$
begin
  if tg_op <> 'INSERT' then
    raise exception 'creation project recordings are immutable';
  end if;
  return new;
end;
$body$;

create trigger creation_project_recordings_immutable
before update or delete on creation_project_recordings
for each row execute function govern_creation_project_recording_mutation();
