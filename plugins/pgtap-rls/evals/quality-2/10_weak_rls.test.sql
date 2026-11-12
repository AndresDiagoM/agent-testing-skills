-- Passes today, but proves little (RLS of public.portfolios and public.fin_budgets).
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@test.local');
insert into public.portfolios (id, user_id, name, kind) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b1', 'B hypothetical', 'hypothetical');

-- user A
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from public.portfolios where id = '00000000-0000-0000-0000-00000000aa01'), 0, 'A does not see B portfolio');
select is((select count(*)::int from public.fin_budgets), 0, 'A sees no budgets');
select lives_ok($$delete from public.portfolios where id = '00000000-0000-0000-0000-00000000aa01'$$, 'A cannot delete B portfolio');
select lives_ok($$update public.portfolios set name = 'hacked' where id = '00000000-0000-0000-0000-00000000aa01'$$, 'A cannot update B portfolio');
select throws_ok($$insert into public.portfolios (user_id, name, kind) values ('00000000-0000-0000-0000-0000000000b1', 'x', 'hypothetical')$$, '42501', null, 'A cannot insert for B');

-- anon
reset role;
set local role anon;
select throws_ok($$select 1 from public.portfolios$$, '42501', null, 'anon cannot read portfolios');
select throws_ok($$insert into public.portfolios (name, kind) values ('anon', 'hypothetical')$$, '42501', null, 'anon cannot insert');

select * from finish();
rollback;
