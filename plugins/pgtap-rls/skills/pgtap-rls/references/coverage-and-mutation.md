# Coverage and "prove the test can fail"

## RLS coverage (one recipe)
pgTAP has no built-in "RLS enabled" assertion. Use `assets/rls-coverage.test.sql`: three `is_empty` checks over the
catalog (ran 2026-11-12, see `VERSIONS.md`):
1. ordinary tables in `public` with RLS off;
2. tables with RLS on and no policy, unless allowlisted as deny-all;
3. policies that apply to the `public` pseudo-role (a forgotten `to <role>`).
Exceptions go in the arrays inside the file, each with a reason on the same line. Do not enumerate tables by hand.

## Pin the policy set
Per table: `policies_are('public', '<table>', array['<policy>', ...], desc)`; for sensitive ones also
`policy_cmd_is(schema, table, policy, 'UPDATE', desc)` and `policy_roles_are`. The catalog check is not the test:
the behaviour cases from `policy-matrix.md` are mandatory.

## Mutation check (one recipe)
Goal: show that a deny test goes red when the protection is removed.
1. Policy-based denial (M1): temporary permissive policy inside the test transaction, right after `plan(N)`:
   `create policy zz_mutation_tmp on public.<t> as permissive for <cmd> to <role> using (true)` (`with check (true)`
   for insert and update; select and delete take `using` only). Permissive policies OR together.
2. Grant-based denial (M2): `grant <priv> on public.<t> to <role>;` (or `grant execute on function ...`).
   `using (true)` does not flip a missing grant, so M2 is the mutation for `42501` grant denials. A grant alone also
   does not flip it when RLS is on with no matching policy (the denial is still `42501`): pair it with the policy
   (`--cmd insert --grant insert`).
3. Generate the mutated COPY with `scripts/mutate-test.mjs <file> --table <t> --cmd <c> --role <r> [--grant <priv>]`.
   It never edits the original and prints the command to run against the LOCAL stack
   (`supabase test db <copy>`; the CLI 3.1.0 accepts a path outside `supabase/` on Windows, verified 2026-11-12, so
   `--in-folder` is only a fallback: delete the `_mutation_` file afterwards and never commit it). Running the copy
   through `psql -f` instead works too but its exit code is 0 even with `not ok` lines: read the TAP, not the exit code.
4. Expected: non-zero exit and the deny tests of that table, command and role named as failed. Record it with
   `scripts/tap-to-evidence.mjs run --mutation -- <same command>` (step `db:test:mutation`; "passed" means the mutation was detected).
5. A deny test that stays green is vacuous (no fixture row, wrong role, empty set, error swallowed by `lives_ok`).
   Fix the test and repeat. Delete the scratch copy.
M1 means nothing on a table whose policy is already `using (true)`: use M2 or a write-side mutation.
UPDATE and DELETE also need the row to pass the SELECT policy: if SELECT hides the victim row, `--cmd update` or
`--cmd delete` alone leaves the deny test green (seen on a real table, 2026-11-12). Use `--cmd all` (or mutate select as
well) for those tests.

## Never make a test pass by changing the code under test
If a test disagrees with a migration, stop and write one line: `table.cmd, role, expected, observed, migration
file:line, source of the expectation`. Ask which is intended. Dropping the real policy to "see what happens" proves
nothing: with no policy every read is denied, so deny tests pass.

## Weakening bans
No `skip()` or `todo_start()`, no removed assertions, no broader row filters, no exact count replaced by `>= 0`, no
`lives_ok` where `throws_ok` or a row check belongs. A needed skip requires the user's approval (or the
orchestrator quoting a standing user instruction), is never approved by the agent that writes it, and is listed in
the evidence step under `approvedSkips[]`.
