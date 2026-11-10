alter table creation_project_recordings
  add column archive_request_id uuid not null default gen_random_uuid();

create unique index creation_project_recordings_tenant_archive_request_key
  on creation_project_recordings (tenant_id, archive_request_id);
