create or replace function reject_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_append_only
before update or delete on audit_events
for each row execute function reject_audit_event_mutation();
