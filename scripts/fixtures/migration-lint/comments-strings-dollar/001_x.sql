-- if tg_op = 'delete' then
/* outer /* nested tg_op = 'delete' */ still a comment: tg_op = 'insert' */
create or replace function x_guard()
returns trigger
language plpgsql
as $fn$
declare
  template text := $q$ if tg_op = 'delete' then $q$;
begin
  -- tg_op = 'update' in a line comment
  /* tg_op = 'update' in a block comment */
  raise notice 'tg_op = ''delete''';
  perform $$ tg_op = 'delete' $$;
  if tg_op = 'update' then
    raise exception 'the only real comparison';
  end if;
  return new;
end;
$fn$;
