# Template: `claims-aal2.test.sql`

Code template shipped as Markdown in the directory edition (full edition: `assets/claims-aal2.test.sql`).
Copy the code below into the user's repository as `claims-aal2.test.sql` and adapt it as the references say.
The plugin never runs it.

```sql
-- 12_docs_aal2.test.sql  |  worked example: a policy that reads a JWT claim (aal) + a restrictive policy  |  verified 2026-11-12 on the local stack, see VERSIONS.md
-- Self-contained: table, grants, permissive policies and the restrictive policy are created INSIDE the transaction and
-- removed by rollback. In a real project the restrictive policy lives in a migration: delete that statement and keep the tests.
-- Rule shown here: when a policy reads auth.jwt() claims, EVERY switch sets the FULL claims object (sub, role, aal, ...).
-- A switch that sets only the sub leaves auth.jwt()->>'aal' null, so a denial passes for the wrong reason (the TRAP block shows it).
-- ids: file 12; owner = ...0a, other = ...0b.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- ---------- example table and policies (replace with the real ones) ----------
create table public.zz_docs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  body text not null
);
alter table public.zz_docs enable row level security;
revoke all on public.zz_docs from anon, authenticated;
grant select, insert on public.zz_docs to authenticated;
create policy zz_docs_select on public.zz_docs for select to authenticated using (user_id = (select auth.uid()));
create policy zz_docs_insert on public.zz_docs for insert to authenticated with check (user_id = (select auth.uid()));
-- restrictive policies AND with the permissive ones: a row is visible or writable only when this also passes
create policy zz_docs_require_aal2 on public.zz_docs as restrictive for all to authenticated
  using ((select auth.jwt()->>'aal') = 'aal2');

-- ---------- fixtures as the migration role ----------
insert into auth.users (id, email) values
  ('12000000-0000-0000-0000-00000000000a', '12-owner@test.local'),
  ('12000000-0000-0000-0000-00000000000b', '12-other@test.local');
insert into public.zz_docs (id, user_id, body) values
  ('12a00000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-00000000000a', 'doc a1');

-- ================= OWNER at aal2 (positive control) =================
reset role;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select auth.jwt()->>'aal'), 'aal2', 'claims guard: the session really carries aal2');
select is((select count(*)::int from public.zz_docs where id = '12a00000-0000-0000-0000-000000000001'), 1, 'owner at aal2 reads their row (positive control)');
select lives_ok($$insert into public.zz_docs (user_id, body) values ('12000000-0000-0000-0000-00000000000a', 'doc a2')$$, 'owner at aal2 can insert (positive control)');

-- ================= OWNER at aal1 (same user, weaker session) =================
reset role;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select auth.jwt()->>'aal'), 'aal1', 'claims guard: the session really carries aal1');
select is_empty($$select 1 from public.zz_docs where id = '12a00000-0000-0000-0000-000000000001'$$, 'owner at aal1 cannot read their row (restrictive using)');
select throws_ok($$insert into public.zz_docs (user_id, body) values ('12000000-0000-0000-0000-00000000000a', 'doc a3')$$, '42501', null, 'owner at aal1 cannot insert (restrictive policy also checks the new row)');

-- ================= OTHER USER at aal2 (the owner binding still holds) =================
reset role;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is_empty($$select 1 from public.zz_docs where id = '12a00000-0000-0000-0000-000000000001'$$, 'other user at aal2 cannot read the owner row (permissive policy)');

-- ================= THE TRAP: claims with only the sub =================
-- Not a test to copy: it shows why. Here the owner is denied only because aal is null, not because anything else is wrong.
reset role;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select is((select auth.jwt()->>'aal'), null, 'sub-only claims: aal is null');
select is_empty($$select 1 from public.zz_docs where id = '12a00000-0000-0000-0000-000000000001'$$, 'sub-only claims: the owner read is empty too, so an aal1 denial tested this way proves nothing');

-- ================= back at aal2: the row was never lost =================
reset role;
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select count(*)::int from public.zz_docs where user_id = '12000000-0000-0000-0000-00000000000a'), 2, 'owner at aal2 still sees exactly their two rows (the aal1 insert did not land)');

select * from finish();
rollback;
```
