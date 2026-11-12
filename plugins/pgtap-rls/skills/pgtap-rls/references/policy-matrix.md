# Policy matrix: what "complete" means

Worked file: `assets/policy-matrix.test.sql` (ran green, 18/18, on the local stack 2026-11-12, see `VERSIONS.md`).

## Required cells per table
Rows = commands (select, insert, update, delete). Columns = anon, owner, other user, service_role.
- owner: one allow case per command;
- other user: one deny case per command;
- anon: one deny case;
- service_role: positive control only;
- plus "owner but forbidden by an extra predicate" when the policy has one.
Every deny case has a positive control next to it (the owner CAN see or change the same row). A deny test whose
fixture row does not exist passes for the wrong reason.

## Which layer denies (assert the one that applies)
| Denial | Observed | Assertion |
|---|---|---|
| missing grant (any command) | error `42501` | `throws_ok(sql, '42501', null, desc)` |
| RLS filter on SELECT | 0 rows, no error | `is((select count(*)::int ...), 0, desc)` |
| RLS filter on UPDATE or DELETE | 0 rows, no error | silent recipe below |
| `with check` on INSERT or UPDATE | error `42501` | `throws_ok(sql, '42501', null, desc)` |
| composite or plain FK to a row you cannot see | `23503` | assert `23503` and say which layer it is |
| trigger that finds no row under RLS | the trigger's own code (e.g. `23514`) | assert the observed code and comment why |

## Silent denial recipe (the only one)
```sql
-- owner: positive control
select is((select count(*)::int from public.t where id = '<row-id>'), 1, 'owner sees the row');
-- other user: no error, zero rows touched
select is_empty($$update public.t set col = 'x' where id = '<row-id>' returning 1$$, 'other user UPDATE touches 0 rows');
select is_empty($$delete from public.t where id = '<row-id>' returning 1$$, 'other user DELETE touches 0 rows');
-- owner again (switch back with the three statements): the row is unchanged
select is((select col from public.t where id = '<row-id>'), '<original>', 'row unchanged');
```
`is_empty` over a DML `returning` string works (verified 2026-11-12: a refused UPDATE/DELETE returns an empty set). The
`DO` block with `get diagnostics n = row_count` that raises when `n <> 0`, inside `lives_ok`, is the equivalent form
that the reference project's own suite uses; either is fine.

## Other shapes
- **Column-level grants:** allow on the granted column, `42501` on the others.
- **Child table through a parent:** the other user inserting a child row for the owner's parent is denied.
- **Views:** a `security_invoker` view hides foreign rows. A view without it bypasses RLS: test it, do not assume.
- **Read-for-all tables (`using (true)`):** allow select for authenticated, deny writes (grant-based, `42501`), deny anon.
- **Deny-all tables (RLS on, no policy):** authenticated gets `42501` or 0 rows; `service_role` reads as positive control.
- **Naming:** `'<actor> <can|cannot> <verb> <object> (<layer>)'`, one assertion per behaviour, exact `plan(N)`.

## Common vacuous patterns
Asserting 0 on a table nobody seeded; `lives_ok` around a denied UPDATE (it passes whether or not the row changed);
anon with a user's leftover claims; deny cases with no positive control. `coverage-and-mutation.md` catches them.
