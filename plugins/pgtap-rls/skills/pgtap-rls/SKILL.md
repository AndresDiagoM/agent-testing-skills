---
name: pgtap-rls
description: "Write, review and run pgTAP tests for Row Level Security, grants and SQL functions in Supabase/Postgres projects (supabase/tests/database/*.test.sql, `supabase test db`): allow and deny cases per role (anon, owner, other user, service_role only for setup), JWT impersonation in a rolled-back transaction, silent UPDATE/DELETE denials, rls_enabled coverage, security definer and RPC checks, and a mutation check that proves a test can fail. Use when asked to test, audit or verify RLS policies, grants or SQL functions, to add or fix pgTAP tests, or to check that one user cannot read or write another user's rows. Not for Playwright/e2e or Vitest/Jest tests, query performance, or designing the policies themselves."
license: Apache-2.0
compatibility: Needs the Supabase CLI and a running local Supabase stack (Docker) for `supabase test db`; Node 20+ for the optional scripts. Verified on Supabase CLI 3.1.0 / Postgres 17.
metadata:
  version: "0.1.0"
  verified-against: "Supabase CLI 3.1.0, Postgres 17.11, pgTAP 1.3.3 on a local stack (2026-11-12); client-level template not yet run, see references/VERSIONS.md"
---

# pgTAP tests for RLS

Repo rules (AGENTS.md, `.claude/rules/*`, OVERRIDES.md) win over this skill.

1. **Layout.** Tests go in `supabase/tests/database/NN_topic.test.sql`; every file is `begin; create extension if not exists pgtap with schema extensions; select plan(N); ... select * from finish(); rollback;` with an exact `plan(N)`.
2. **Local only.** Run only on the local stack via the repo script (`db:test`) or `supabase test db [paths]`; never pass `--remote`, never use `db reset`, `db push`, or a linked/remote DB for tests. If the stack is down, say so and stop (start it only if the repo rules or the user allow).
3. **Discover before writing.** Read the migrations (and, if the stack is up, the catalog) for tables, each policy's command/role/`using`/`with check`, grants and functions; never write tests from memory.
4. **Impersonate exactly.** `reset role;` then `select set_config('request.jwt.claims', '<json>', true);` then `set local role <role>;`. Claims for `anon` and `service_role` are `{"role":"anon"}` / `{"role":"service_role"}`, never a leftover user's claims.
5. **Matrix per policy.** For every table x command (select, insert, update, delete) x role (anon, owner, other user; service_role only to seed/read back) write one allow and one deny case, plus a positive control next to every deny.
6. **Know which layer denies.** Missing grant gives `42501` on any command; an RLS filter on SELECT/UPDATE/DELETE gives 0 rows and no error; `with check` on INSERT/UPDATE gives `42501`. Assert the layer that applies.
7. **Silent denials are asserted twice.** Other user (owning no rows): `is_empty(update t set c = 1 returning 1)`, no `where` (a column read applies the SELECT policy and can hide an open UPDATE policy); then re-read it as its owner.
8. **Every user table has RLS enabled** and its policy set pinned (`rls-coverage.test.sql`, `policies_are`); the table list comes from the catalog.
9. **Prove each deny test can fail.** Mutation check on the test (`scripts/mutate-test.mjs`): a temporary permissive `using (true)` policy (or a temporary grant, for grant denials) inside the test transaction must turn the deny test red. A test that stays green is vacuous: fix it.
10. **Never edit a policy, grant, function or migration to make a test pass.** If code and expectation disagree, stop and report the discrepancy (table, command, role, expected, actual, migration:line). Never weaken or delete an assertion, `skip()`, or `todo()` to get green.
11. **Functions.** For each: definer or invoker, `search_path` (`proconfig`), owner, `auth.uid()` use, EXECUTE grants per role, and a call with another user's ids.
12. **Fast and isolated.** No `db reset` per test; ids unique per file; fixtures created inside the file's transaction; never assert counts of seed data.
13. **No literal secrets, not even fake ones** (JWTs, keys, passwords): claims are built from ids; client-level tests read env vars or generate values at runtime. No destructive commands in examples.
14. **Report with evidence.** Run the full DB suite once, re-run only a failing file, finish with one full run; record it with `scripts/tap-to-evidence.mjs` and report wall time and passed/failed/skipped. Zero tests is a failure.

## When to read what (`references/`)

| Situation | Read |
|---|---|
| Unmapped repo or table | `discover.md` |
| Any role or claims switch | `impersonation.md` |
| Allow/deny cases, silent denials | `policy-matrix.md` |
| Coverage, pinned policies, mutation | `coverage-and-mutation.md` |
| Function, RPC, trigger, view, grants | `functions-and-grants.md` |
| Slow, flaky, colliding ids | `isolation-and-speed.md` |
| Real sign-in, PostgREST, doubles | `beyond-transactions.md` |
| Running, evidence, parsing TAP | `running-and-evidence.md` |
| Repo overrides, Basejump | `repo-basejump.md` |

Templates: `assets/` (skeleton, policy-matrix, claims-aal2, rls-coverage, client test). Unverified snippets: `references/VERSIONS.md`.
