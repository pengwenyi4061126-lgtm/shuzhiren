alter table channel_connections
  add column verification_evidence_ref text,
  add column verified_by uuid references users(id);
