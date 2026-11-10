create unique index avatar_build_jobs_tenant_project_id_key
  on avatar_build_jobs (tenant_id, project_id, id);

create table creation_project_avatar_selections (
  tenant_id uuid not null references tenants(id) on delete restrict,
  project_id uuid not null,
  avatar_build_job_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, project_id),
  foreign key (tenant_id, project_id) references creation_projects (tenant_id, id) on delete restrict,
  foreign key (tenant_id, project_id, avatar_build_job_id) references avatar_build_jobs (tenant_id, project_id, id) on delete restrict
);

create index creation_project_avatar_selections_job_idx
  on creation_project_avatar_selections (tenant_id, avatar_build_job_id);

alter table creation_project_live_outputs add column avatar_build_job_id uuid;
alter table creation_project_live_outputs
  add constraint creation_project_live_outputs_avatar_job_fk
  foreign key (tenant_id, project_id, avatar_build_job_id) references avatar_build_jobs (tenant_id, project_id, id) on delete restrict;

alter table creation_project_avatar_selections enable row level security;
alter table creation_project_avatar_selections force row level security;
create policy tenant_isolation_creation_project_avatar_selections on creation_project_avatar_selections
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));
