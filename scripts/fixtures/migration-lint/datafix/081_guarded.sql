-- Guarded data fixes, DML inside a function body and INSERT ... VALUES are allowed.
select migration_fix_update('fixture_rows', 'row', $set$ note = 'migrated' $set$, $where$ row.note is null $where$);
create or replace function fixture_touch() returns void language plpgsql as $$
begin
  update fixture_rows set note = 'touched';
end;
$$;
insert into fixture_audit (id) values (2);
