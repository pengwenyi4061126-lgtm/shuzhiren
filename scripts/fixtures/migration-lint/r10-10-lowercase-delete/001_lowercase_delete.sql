create or replace function guard_fixture()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then
    raise exception 'fixture rows cannot be deleted';
  end if;
  return new;
end;
$$;
