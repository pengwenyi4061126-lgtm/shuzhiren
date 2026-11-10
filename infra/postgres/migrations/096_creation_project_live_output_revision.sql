alter table creation_project_live_outputs
  add column project_revision integer check (project_revision is null or project_revision > 0);
