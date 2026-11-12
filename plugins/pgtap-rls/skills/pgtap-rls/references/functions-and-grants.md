# Functions, RPCs, views and grants

Load when a change touches a function, trigger, RPC, view or grant. The pgTAP calls below ran green on the local stack 2026-11-12 (`VERSIONS.md`).

## Per function, always
1. **Definer or invoker, as intended.** `select is_definer('public', 'f', array['uuid'], 'f is definer')` or
   `isnt_definer(...)`; or the catalog: `select prosecdef from pg_proc where oid = 'public.f(uuid)'::regprocedure`.
   An invoker function runs under the caller's RLS; a definer function bypasses it, so its guard must be inside it.
2. **`search_path` pinned** for every definer function: `proconfig` has a `search_path=...` entry that is empty or lists
   explicit schemas, never `public` first. `select ok(exists (select 1 from pg_proc p, unnest(p.proconfig) c where p.oid = 'public.f(uuid)'::regprocedure and c like 'search_path=%'), desc)`;
   read the stored value once and assert it exactly.
3. **Owner** is the expected role, not an application role: `function_owner_is('public', 'f', array['uuid'], 'postgres', desc)`.
4. **No authorization from a parameter.** A `p_user_id uuid default auth.uid()` must be called with another user's
   id, as `authenticated` and as `service_role`, and the result asserted.
5. **EXECUTE grants per role**, both directions: the granted role can call it, others get `42501`.
   `function_privs_are('public', 'f', array['uuid'], 'anon', array[]::text[], desc)` or behavioural:
   `throws_ok($$select public.f('<id>')$$, '42501', null, 'anon cannot execute f')` after switching to anon with fresh claims.
   Mutation M2 applies (`grant execute` temporarily, `coverage-and-mutation.md`).

## RPC called with another user's ids
Switch to the other user (three statements, `impersonation.md`), call with the owner's id, and assert the code the
function produces (for example `P0002` not-found because RLS hides the row). Then re-read the owner's data as the
owner to prove it is untouched. For a definer function this is the key test: no refusal is a finding. Report it; do
not patch the function.

## Atomicity after a refused call
A call that raises leaves nothing behind: assert row counts or the affected rows after the `throws_ok`.

## Triggers
Only as far as they matter for security (for example a trigger that finds no row under RLS and raises its own code).

## Views
`security_invoker = true`: `select ok((select coalesce(reloptions @> array['security_invoker=true'], false) from pg_class where oid = 'public.v'::regclass), desc)`,
plus a behavioural check that the other user sees 0 rows. A view without the option runs with its owner's rights.

## Grants on tables
`table_privs_are('public', '<t>', 'authenticated', array['SELECT','INSERT'], desc)` pins grants; behaviour still
needs the matrix. Column-level grants: allow case on the granted column, `42501` on the others.
Default privileges can grant new tables to `anon` and `authenticated`: pin the result, do not assume it.
