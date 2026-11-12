-- 00_rls_coverage.test.sql  |  fails when a table in public has no RLS, no policy, or a policy for the PUBLIC role
-- verified 2026-11-12 on the local stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0), see VERSIONS.md. The table list comes from the catalog, never from memory.
-- Exceptions: add the table name inside the arrays below WITH a reason on the same line. A table that is not
-- listed and has RLS off makes this file fail loudly, which is the point.
begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

-- 1. Every ordinary or partitioned table in public has RLS enabled.
select is_empty($$
  select c.relname::text as table_without_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    and not c.relrowsecurity
    and c.relname <> all (array[
      'example_no_rls_table'   -- reason: replace with a real exception and say why it is safe (extension table, ...)
    ]::text[])
  order by 1
$$, 'every table in public has row level security enabled (or is allowlisted with a reason)');

-- 2. RLS on but no policy at all = deny-all. That is valid only when intended: list it with a reason.
select is_empty($$
  select c.relname::text as table_with_rls_and_no_policy
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    and c.relname <> all (array[
      'example_deny_all_table' -- reason: replace with a real exception, e.g. written only by service_role
    ]::text[])
  order by 1
$$, 'every table with RLS has at least one policy (or is allowlisted as deny-all with a reason)');

-- 3. No policy is granted to the PUBLIC pseudo-role by accident (a missing "to <role>" clause).
select is_empty($$
  select tablename::text || '.' || policyname::text as policy_for_public
  from pg_policies
  where schemaname = 'public' and roles = array['public']::name[]
  order by 1
$$, 'no policy in public applies to the PUBLIC role');

select * from finish();
rollback;
