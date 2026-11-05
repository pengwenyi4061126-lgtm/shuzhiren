create or replace function same_number_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'delete' then raise exception 'file a'; end if;
  return new;
end;
$$;
