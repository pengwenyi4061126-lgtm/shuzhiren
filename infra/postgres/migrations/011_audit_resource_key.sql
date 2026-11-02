alter table audit_events
  add column if not exists resource_key text;

update audit_events
  set resource_key = resource_id::text
  where resource_key is null and resource_id is not null;
