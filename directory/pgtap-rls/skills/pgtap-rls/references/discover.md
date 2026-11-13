# Discover before writing

Map the target first. Never write RLS tests from memory of the schema.

## Source of truth, in order
1. Migrations in `supabase/migrations/`: tables, `enable row level security`, `create policy`, `grant`, `revoke`, functions.
2. If the local stack is up, the catalog. It wins when they disagree (a later migration may supersede an earlier one).
   Run read-only queries through the repo's own path (a local MCP `execute_sql`, or a throwaway test file that only selects).
   Never use a linked or remote database for this.

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by 1;
select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2;
select p.oid::regprocedure, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
select grantee, table_name, privilege_type from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated','service_role') order by 2, 1, 3;
```

## Generated policies
Policies are often created in `DO` loops with `format()`. `grep "create policy"` then finds the template, not the
table list. Enumerate from `pg_policies`.

## Worksheet (one row per table x command)
table | RLS on | cmd | policy | roles (`TO`) | `using` | `with check` | grants (incl. column-level) | existing test file.

Patterns to recognise:
- owner column: `user_id = (select auth.uid())`;
- child table through its parent: `exists (select 1 from parent p where p.id = child.parent_id and p.user_id = ...)`;
- read-for-all: `using (true)` with writes denied by grants;
- RLS on and no policy: deny-all (only `service_role` can touch it);
- delete with an extra predicate (a row kind that cannot be deleted);
- views: `security_invoker = true` or a bypass.

## What `auth.uid()` reads on this stack
Check once: `select pg_get_functiondef('auth.uid()'::regprocedure);` (the bare name `'auth.uid'::regprocedure` errors;
`::regproc` accepts it). This skill uses the `request.jwt.claims` JSON form (`impersonation.md`). If the definition on
the stack reads only another setting, say so in the report before writing tests. On the local stack checked on
2026-11-12 (Postgres 17.11) it reads `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid`: the claims JSON works, and the
legacy `request.jwt.claim.sub` setting works too and wins when both are set. Check again on any other stack (`VERSIONS.md`).

## Existing coverage
`grep -l <table> supabase/tests/database/*.sql`. List gaps only; do not rewrite passing files.
Output: the worksheet, the gaps, and which findings belong to policy design (hand those back, do not fix them here).
