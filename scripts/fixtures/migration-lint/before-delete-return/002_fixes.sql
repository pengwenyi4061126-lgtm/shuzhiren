drop trigger if exists fixture_dropped_guard on fixture_rows;
create or replace function replaced_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'rows cannot be deleted';
  end if;
  return new;
end;
$$;
