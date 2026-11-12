-- Expectation written by someone who assumed hypothetical portfolios cannot be deleted.
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a2', 'a2@test.local');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","email":"a2@test.local"}', true);
set local role authenticated;

insert into public.portfolios (name, kind) values ('Mine', 'hypothetical');
select is((select count(*)::int from public.portfolios where name = 'Mine'), 1, 'A has a hypothetical portfolio');
delete from public.portfolios where name = 'Mine';
select is((select count(*)::int from public.portfolios where name = 'Mine'), 1, 'A cannot delete their own hypothetical portfolio');

select * from finish();
rollback;
