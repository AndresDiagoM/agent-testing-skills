# pgtap-rls

An agent skill that writes, reviews and runs pgTAP tests for Supabase/Postgres Row Level Security (RLS) policies, grants and SQL functions, and records the result as machine-readable evidence.

## Problems this solves

- **How to test Supabase RLS policies with pgTAP.** A matrix per table: allow and deny for `select`, `insert`, `update`, `delete`, in a rolled-back transaction (`supabase test db`).
- **Test anon vs authenticated vs another user.** One impersonation recipe (`reset role`, claims JSON in `request.jwt.claims`, `set local role`), with correct claims for `anon` and `service_role`.
- **UPDATE/DELETE denied by RLS returns no error.** Assert zero rows affected, then re-read the row as its owner.
- **Prove an RLS test can fail.** A mutation check: a temporary `using (true)` policy or grant in a scratch copy must turn the deny test red. Includes `scripts/mutate-test.mjs`.
- **Check that every table has RLS enabled.** A catalog-based coverage test with an allowlist that needs a reason per table.
- **Security definer function `search_path` test.** Definer or invoker, `search_path`, owner, EXECUTE grants, and a call with another user's ids.
- **What a pgTAP test cannot prove.** Real sign-in, PostgREST error shapes and concurrency, with a client-level test template.
- **Record DB test results for a quality gate.** `scripts/tap-to-evidence.mjs` writes a `db:test` step (counts, failing tests, scope) into the `.gate/last.json` evidence file used by the sibling `test-gate` skill.

## What existing guides leave out

Based only on `docs/research/agent-testing-skills-critique.md` (2026-11-12, section 8 and cross-cutting gaps) from the reference project (internal, not public).

| Topic | What the critique found in existing guidance | What this skill provides |
|---|---|---|
| Agent skill for pgTAP | No pgTAP skill exists. `supabase/agent-skills` has `supabase` and `supabase-postgres-best-practices`; the latter's description mentions RLS tests, but its `security-rls-basics.md` has no lines on testing, pgTAP or impersonation | A dedicated skill for tests; policy design stays with the official skills |
| Impersonation examples | The Supabase guide uses `set local request.jwt.claim.sub`; no anon example, none for service_role, none for claims beyond `sub` or for `auth.jwt()` policies | Claims JSON per role, including `anon` and `service_role`, and a note on stale claims |
| Silent denials | Denied UPDATE and DELETE succeed with zero rows; tests must assert it | `is_empty(... returning 1)` plus a re-read as the owner |
| Proving a test can fail | The guide suggests a temporary permissive policy and not editing a policy to pass a test | A script that builds the mutated copy, a grant variant, and a rule to report discrepancies |
| Basejump helpers | Community add-on; authors advise against production; installed via dbdev; pinned 0.0.6 | Documented as optional; templates do not depend on it |
| Transaction limits | A rolled-back transaction cannot test client-library behaviour or commit-time effects | `beyond-transactions.md` and an optional client-level test template |
| Evidence file | A machine-readable evidence file is listed as a gap nobody covers | `tap-to-evidence.mjs`, schema aligned with `test-gate` |

## Install

Claude Code:
```
/plugin marketplace add AndresDiagoM/agent-testing-skills
/plugin install pgtap-rls@agent-testing-skills
```

Other agents ([Agent Skills](https://agentskills.io) standard):
```
npx skills add AndresDiagoM/agent-testing-skills --skill pgtap-rls
```

## Usage

- "Add pgTAP tests proving user B can't read or update user A's rows in `notes`."
- "Audit the RLS policies in my latest migration and write tests for them."
- "`supabase test db` fails on 01_rls.test.sql, test 7. Help me fix it."
- "Is my `get_balance(uuid)` security definer function safe? Write tests for who can call it."

Scripts (Node 20+, no dependencies, no network): `node skills/pgtap-rls/scripts/tap-to-evidence.mjs --help`, `node skills/pgtap-rls/scripts/mutate-test.mjs --help`.

## Tested with

- Scripts: `node --test` (37 tests) on Node 26, Windows.
- SQL templates and reference snippets: ran green on a local Supabase stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0) on 2026-11-12; the optional client-level template is not run yet. `skills/pgtap-rls/references/VERSIONS.md` has the list.
- Agents: not yet tested in Claude Code or another agent (see `CHECKLIST.md`).
- Written for Supabase CLI 3.1.0 / Postgres 17.

## License

Apache-2.0
