-- M12: a data-fix statement in a migration (048 resolves duplicate open alerts, 061 disables unverified channel
-- connections) is filtered by FORCE ROW LEVEL SECURITY when the migration role owns the tables but has no
-- BYPASSRLS and sets no app.tenant_id, so it silently changes 0 rows.
--
-- From 079 on, a migration changes existing rows only through the functions below; the Migrator refuses a pending
-- migration numbered 079 or higher with a top-level UPDATE, DELETE, MERGE, INSERT ... SELECT or data-modifying
-- WITH, also inside a DO block. Each function counts the target rows without RLS, runs the statement under the
-- normal RLS rules, and raises when the two numbers differ, which rolls the migration back before
-- schema_migrations records it.
--
-- migration_unfiltered_count lifts FORCE on the listed tables (the migration role owns them) and turns
-- row_security off for the count, then restores both. A predicate that reads an RLS table missing from the list
-- fails with 42501 instead of returning a filtered count. With p_per_tenant the statement runs once per tenant
-- with app.tenant_id set to that tenant and a tenant_id predicate on the target, and the original app.tenant_id
-- is restored afterwards.
create or replace function migration_unfiltered_count(p_tables regclass[], p_count_sql text)
returns bigint
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  forced regclass[];
  forced_table regclass;
  previous_row_security text := current_setting('row_security');
  result bigint;
begin
  select coalesce(array_agg(distinct c.oid::regclass), '{}') into forced
  from pg_class c
  where c.oid = any(p_tables) and c.relforcerowsecurity;
  foreach forced_table in array forced loop
    execute format('alter table %s no force row level security', forced_table);
  end loop;
  perform set_config('row_security', 'off', true);
  execute p_count_sql into result;
  perform set_config('row_security', previous_row_security, true);
  foreach forced_table in array forced loop
    execute format('alter table %s force row level security', forced_table);
  end loop;
  return result;
end;
$$;

create or replace function migration_assert_row_count(p_target regclass, p_expected bigint, p_affected bigint)
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_expected is distinct from p_affected then
    raise exception 'data-fix row count mismatch on %: expected % rows, affected %', p_target, p_expected, p_affected;
  end if;
end;
$$;

create or replace function migration_fix_update(p_target regclass, p_alias text, p_set text, p_where text,
  p_from text default null, p_read_tables regclass[] default '{}', p_per_tenant boolean default false)
returns bigint
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  expected bigint;
  affected bigint := 0;
  step bigint;
  tenant uuid;
  previous_tenant text := current_setting('app.tenant_id', true);
  statement text;
begin
  expected := migration_unfiltered_count(array[p_target] || p_read_tables,
    case when p_from is null
      then format('select count(*) from %s as %I where (%s)', p_target, p_alias, p_where)
      else format('select count(*) from %s as %I where exists (select 1 from %s where (%s))', p_target, p_alias, p_from, p_where)
    end);
  statement := format('update %s as %I set %s%s where (%s)', p_target, p_alias, p_set,
    case when p_from is null then '' else ' from ' || p_from end, p_where);
  if p_per_tenant then
    for tenant in select id from public.tenants order by id loop
      perform set_config('app.tenant_id', tenant::text, true);
      execute statement || format(' and %I.tenant_id = $1', p_alias) using tenant;
      get diagnostics step = row_count;
      affected := affected + step;
    end loop;
    perform set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  else
    execute statement;
    get diagnostics affected = row_count;
  end if;
  perform migration_assert_row_count(p_target, expected, affected);
  return affected;
end;
$$;

create or replace function migration_fix_delete(p_target regclass, p_alias text, p_where text,
  p_using text default null, p_read_tables regclass[] default '{}', p_per_tenant boolean default false)
returns bigint
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  expected bigint;
  affected bigint := 0;
  step bigint;
  tenant uuid;
  previous_tenant text := current_setting('app.tenant_id', true);
  statement text;
begin
  expected := migration_unfiltered_count(array[p_target] || p_read_tables,
    case when p_using is null
      then format('select count(*) from %s as %I where (%s)', p_target, p_alias, p_where)
      else format('select count(*) from %s as %I where exists (select 1 from %s where (%s))', p_target, p_alias, p_using, p_where)
    end);
  statement := format('delete from %s as %I%s where (%s)', p_target, p_alias,
    case when p_using is null then '' else ' using ' || p_using end, p_where);
  if p_per_tenant then
    for tenant in select id from public.tenants order by id loop
      perform set_config('app.tenant_id', tenant::text, true);
      execute statement || format(' and %I.tenant_id = $1', p_alias) using tenant;
      get diagnostics step = row_count;
      affected := affected + step;
    end loop;
    perform set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  else
    execute statement;
    get diagnostics affected = row_count;
  end if;
  perform migration_assert_row_count(p_target, expected, affected);
  return affected;
end;
$$;

-- p_select must produce the columns of p_columns in order; with p_per_tenant it must also output tenant_id.
create or replace function migration_fix_insert(p_target regclass, p_columns text, p_select text,
  p_read_tables regclass[] default '{}', p_per_tenant boolean default false)
returns bigint
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  expected bigint;
  affected bigint := 0;
  step bigint;
  tenant uuid;
  previous_tenant text := current_setting('app.tenant_id', true);
  statement text;
begin
  expected := migration_unfiltered_count(array[p_target] || p_read_tables, format('select count(*) from (%s) as s', p_select));
  statement := format('insert into %s (%s) select s.* from (%s) as s', p_target, p_columns, p_select);
  if p_per_tenant then
    for tenant in select id from public.tenants order by id loop
      perform set_config('app.tenant_id', tenant::text, true);
      execute statement || ' where s.tenant_id = $1' using tenant;
      get diagnostics step = row_count;
      affected := affected + step;
    end loop;
    perform set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
  else
    execute statement;
    get diagnostics affected = row_count;
  end if;
  perform migration_assert_row_count(p_target, expected, affected);
  return affected;
end;
$$;

revoke all on function migration_unfiltered_count(regclass[], text) from public;
revoke all on function migration_assert_row_count(regclass, bigint, bigint) from public;
revoke all on function migration_fix_update(regclass, text, text, text, text, regclass[], boolean) from public;
revoke all on function migration_fix_delete(regclass, text, text, text, regclass[], boolean) from public;
revoke all on function migration_fix_insert(regclass, text, text, regclass[], boolean) from public;
