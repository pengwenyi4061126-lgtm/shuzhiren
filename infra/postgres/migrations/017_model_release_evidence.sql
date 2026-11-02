alter table model_releases
  add column evidence_ref text not null default '',
  add column validation_summary text not null default '';

alter table model_releases
  alter column evidence_ref drop default,
  alter column validation_summary drop default;
