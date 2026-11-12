-- 11_notes_rls.test.sql  |  worked example of the policy matrix  |  verified 2026-11-12 on the local stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0), see VERSIONS.md
-- Self-contained: the example table, its grants and its policies are created INSIDE the transaction and removed by
-- rollback, so the file runs on any local Supabase stack. Replace the table block with your real table (use the
-- catalog, not memory, to read its policies) and keep the test blocks.
-- Table-specific parts: the "example table" block and the table name. Generic parts: roles, claims, silent denials.
-- ids: file 11; owner = ...0a, other = ...0b.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

-- ---------- example table (replace with the real one) ----------
create table public.zz_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  body text not null
);
alter table public.zz_notes enable row level security;
revoke all on public.zz_notes from anon, authenticated;
grant select, insert, update, delete on public.zz_notes to authenticated;
grant all on public.zz_notes to service_role;
create policy zz_notes_select on public.zz_notes for select to authenticated using (user_id = (select auth.uid()));
create policy zz_notes_insert on public.zz_notes for insert to authenticated with check (user_id = (select auth.uid()));
create policy zz_notes_update on public.zz_notes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy zz_notes_delete on public.zz_notes for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- fixtures as the migration role ----------
insert into auth.users (id, email) values
  ('11000000-0000-0000-0000-00000000000a', '11-owner@test.local'),
  ('11000000-0000-0000-0000-00000000000b', '11-other@test.local');
insert into public.zz_notes (id, user_id, body) values
  ('11a00000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-00000000000a', 'a1'),
  ('11a00000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-00000000000a', 'a2'),
  ('11b00000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-00000000000b', 'b1');

-- ================= OWNER (allow cases + positive control) =================
reset role;
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 1, 'owner sees their own row (positive control)');
select lives_ok($$insert into public.zz_notes (user_id, body) values ('11000000-0000-0000-0000-00000000000a', 'a3')$$, 'owner can insert a row for themselves (with check)');
select lives_ok($$update public.zz_notes set body = 'edited' where id = '11a00000-0000-0000-0000-000000000001'$$, 'owner can update their own row');
select is((select body from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 'edited', 'owner update is visible');
select lives_ok($$delete from public.zz_notes where id = '11a00000-0000-0000-0000-000000000002'$$, 'owner can delete their own row');
select is((select count(*)::int from public.zz_notes where id = '11a00000-0000-0000-0000-000000000002'), 0, 'owner delete took effect');

-- ================= OTHER USER (deny cases; each has a positive control above) =================
reset role;
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;

-- SELECT is filtered by RLS: no error, zero rows
select is((select count(*)::int from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 0, 'other user cannot see the owner row (RLS filters, 0 rows)');
-- INSERT is refused by WITH CHECK: error 42501
select throws_ok($$insert into public.zz_notes (user_id, body) values ('11000000-0000-0000-0000-00000000000a', 'x')$$, '42501', null, 'other user cannot insert a row for the owner (with check)');
-- UPDATE and DELETE are silent: no error, zero rows touched
select is_empty($$update public.zz_notes set body = 'hacked' where id = '11a00000-0000-0000-0000-000000000001' returning 1$$, 'other user UPDATE touches 0 rows');
select is_empty($$delete from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001' returning 1$$, 'other user DELETE touches 0 rows');
-- moving their own row to the owner is refused by WITH CHECK on UPDATE
select throws_ok($$update public.zz_notes set user_id = '11000000-0000-0000-0000-00000000000a' where id = '11b00000-0000-0000-0000-000000000001'$$, '42501', null, 'other user cannot hand their row to the owner (with check on update)');

-- Re-read the victim row as its owner: still there, unchanged
reset role;
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select is((select body from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 'edited', 'owner row survived the other user attempts unchanged');

-- ================= ANON (claims carry the role only; here the denial comes from the missing grant) =================
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select * from public.zz_notes$$, '42501', null, 'anon cannot read (no grant)');
select throws_ok($$insert into public.zz_notes (user_id, body) values ('11000000-0000-0000-0000-00000000000a', 'x')$$, '42501', null, 'anon cannot insert (no grant)');

-- ================= SERVICE_ROLE (bypasses RLS: positive control only) =================
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is((select count(*)::int from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 1, 'service_role sees the row (bypasses RLS)');

-- ================= CATALOG PINS (as the migration role) =================
reset role;
select ok((select relrowsecurity from pg_class where oid = 'public.zz_notes'::regclass), 'RLS is enabled on zz_notes');
select policies_are('public', 'zz_notes', array['zz_notes_select', 'zz_notes_insert', 'zz_notes_update', 'zz_notes_delete'], 'zz_notes has exactly these policies');
select policy_cmd_is('public', 'zz_notes', 'zz_notes_update', 'UPDATE', 'zz_notes_update applies to UPDATE');

select * from finish();
rollback;
