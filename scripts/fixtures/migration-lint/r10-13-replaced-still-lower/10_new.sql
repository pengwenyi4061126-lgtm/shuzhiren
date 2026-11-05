create or replace function enforce_x()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'Delete' then
    raise exception 'x rows cannot be deleted';
  end if;
  return new;
end;
$$;
