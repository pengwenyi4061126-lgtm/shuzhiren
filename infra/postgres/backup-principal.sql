-- Run this file as the same schema-owner role that runs migrations, after all
-- migrations and after a privileged DBA creates shuzhiren_backup as LOGIN
-- NOINHERIT BYPASSRLS. Its password belongs only in /etc/shuzhiren/backup.env.
-- This is deliberately separate from application service principals: pg_dump
-- needs a complete, RLS-bypassing read of the database, while application
-- services must never receive that capability.
do $$
declare
  backup_role record;
begin
  select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole,
         rolcreatedb, rolreplication
    into backup_role
    from pg_roles
   where rolname = 'shuzhiren_backup';
  if not found then
    raise exception 'backup role shuzhiren_backup is missing; create it as LOGIN NOINHERIT BYPASSRLS before applying backup-principal.sql';
  end if;
  if not backup_role.rolcanlogin or backup_role.rolinherit or not backup_role.rolbypassrls
     or backup_role.rolsuper or backup_role.rolcreaterole or backup_role.rolcreatedb
     or backup_role.rolreplication then
    raise exception 'backup role shuzhiren_backup must be LOGIN NOINHERIT BYPASSRLS without administrative capabilities';
  end if;
  if exists (select 1 from pg_auth_members membership join pg_roles member_role on member_role.oid = membership.member where member_role.rolname = 'shuzhiren_backup') then
    raise exception 'backup role shuzhiren_backup must not inherit memberships';
  end if;
end;
$$;

do $$
begin
  execute format('grant connect on database %I to shuzhiren_backup', current_database());
end;
$$;

revoke all privileges on all tables in schema public from shuzhiren_backup;
revoke all privileges on all sequences in schema public from shuzhiren_backup;
revoke all privileges on all functions in schema public from shuzhiren_backup;
revoke all privileges on schema public from shuzhiren_backup;

grant usage on schema public to shuzhiren_backup;
grant select on all tables in schema public to shuzhiren_backup;
grant usage, select on all sequences in schema public to shuzhiren_backup;

-- Future migration objects created by this schema owner remain dumpable without
-- granting the backup role any write, execute, ownership, or role-management right.
alter default privileges in schema public grant select on tables to shuzhiren_backup;
alter default privileges in schema public grant usage, select on sequences to shuzhiren_backup;
