create function enforce_x()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then
    raise exception 'x rows cannot be deleted';
  end if;
  return new;
end;
$$;
