# Template: `test-skeleton.test.sql`

Code template shipped as Markdown in the directory edition (full edition: `assets/test-skeleton.test.sql`).
Copy the code below into the user's repository as `test-skeleton.test.sql` and adapt it as the references say.
The plugin never runs it.

```sql
-- NN_topic.test.sql  |  spec / acceptance ids: <ids>  |  verified 2026-11-12 on the local stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0), see VERSIONS.md
-- Copy to supabase/tests/database/NN_topic.test.sql. Replace every <placeholder>, the plan count and the example
-- table. User ids are unique per FILE: the first UUID group is the file number (here 10), the last char is the actor.
-- Fixtures live inside this file's transaction and are removed by rollback.
begin;
create extension if not exists pgtap with schema extensions;
select plan(1);

-- Fixtures as the migration role, BEFORE the first role switch. If auth.users has triggers (profile rows, ...), say so here.
insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-00000000000a', '10-owner@test.local'),
  ('10000000-0000-0000-0000-00000000000b', '10-other@test.local');
-- insert into public.<table> (...) values (...);   -- seed rows with fixed ids, as postgres

-- ===== Owner (authenticated, sub = owner). Three statements, always in this order: =====
reset role;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
-- positive control first (the owner CAN see the row), then the owner's allow cases:
-- select is((select count(*)::int from public.<table> where id = '<row-id>'), 1, 'owner sees the row');

-- ===== Other user (authenticated, different sub): every deny case sits next to a positive control =====
-- reset role;
-- select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
-- set local role authenticated;

-- ===== anon: claims carry the role only, never a leftover user's claims =====
-- reset role;
-- select set_config('request.jwt.claims', '{"role":"anon"}', true);
-- set local role anon;

-- ===== service_role: seed or read back, plus one positive control; it bypasses RLS =====
-- reset role;
-- select set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- set local role service_role;

reset role;
select pass('skeleton runs: replace this assertion and the plan count');

select * from finish();
rollback;
```
