# pgtap-rls

An agent skill that writes, reviews and runs pgTAP tests for Supabase/Postgres Row Level Security (RLS) policies, grants and SQL functions, and records the result as machine-readable evidence.

## Problems this solves

- **How to test Supabase RLS policies with pgTAP.** A matrix per table: allow and deny for `select`, `insert`, `update`, `delete`, in a rolled-back transaction (`supabase test db`).
- **Test anon vs authenticated vs another user.** One impersonation recipe (`reset role`, claims JSON in `request.jwt.claims`, `set local role`), with correct claims for `anon` and `service_role`, and the full claims object for policies that read `aal` or `app_metadata` (worked `aal2` restrictive-policy example).
- **UPDATE/DELETE denied by RLS returns no error.** Assert zero rows affected with unfiltered probes (a column read would apply the SELECT policy and can hide a too-open UPDATE or DELETE policy), then re-read the row as its owner. Also tests that a user cannot hand their row to another owner.
- **Prove an RLS test can fail.** A mutation check: a temporary `using (true)` policy or grant in a scratch copy must turn the deny test red. Includes `scripts/mutate-test.mjs`.
- **Check that every table has RLS enabled.** A catalog-based coverage test with an allowlist that needs a reason per table.
- **Security definer function `search_path` test.** Definer or invoker, `search_path`, owner, EXECUTE grants, and a call with another user's ids.
- **What a pgTAP test cannot prove.** Real sign-in, PostgREST error shapes and concurrency, with a client-level test template.
- **Record DB test results for a quality gate.** `scripts/tap-to-evidence.mjs` writes a `db:test` step (counts, failing tests, scope) into the `.gate/last.json` evidence file used by the sibling `test-gate` skill.

## How existing guides compare

Based on the upstream files as of 2026-11-12, at the commits listed in [docs/why.md](../../docs/why.md#sources). "Not covered" means not found in the files read at that commit. The Supabase docs and the skills named here are good starting points; `pgtap-rls` is meant to sit next to them.

| Topic | What existing guidance covers | What this skill provides |
|---|---|---|
| Agent skills for pgTAP | Other pgTAP skills exist, for example [`github/awesome-copilot` `supabase-rls-policies`](https://github.com/github/awesome-copilot/blob/e593e6649d3b538772b7329b26bcd626b54900ff/skills/supabase-rls-policies/SKILL.md) (see "Using it with `supabase-rls-policies`" below) and [`nghiahsgs/taw-kit` `testing-rls-pgtap`](https://github.com/nghiahsgs/taw-kit/blob/9cfb26af52/skills/testing-rls-pgtap/SKILL.md). The official `supabase/agent-skills` skills (`supabase`, `supabase-postgres-best-practices`) mention RLS tests in a description, but their `security-rls-basics.md` has no lines on testing or pgTAP | A dedicated skill for tests, with scripts and the evidence file below; policy design stays with the official skills |
| Impersonation examples | The Supabase docs' policy tests cover `anon` and `authenticated` and set `request.jwt.claim.sub`; they show no `service_role` or other claims | Claims JSON per role, including `anon` and `service_role`, and a note on stale claims |
| Silent denials | The Supabase docs assert a denied UPDATE or DELETE with `is_empty(... returning 1)` and a re-read | The same pattern inside the per-table allow/deny matrix |
| Proving a test can fail | The Supabase docs and the awesome-copilot skill suggest a temporary `using (true)` policy and not editing a policy to pass a test | A script that builds the mutated copy, a grant variant, and a rule to report discrepancies |
| Basejump helpers | Community add-on documented in the Supabase docs (pinned `0.0.6`, installed via dbdev); its README does not recommend activating it directly in production | Documented as optional; templates do not depend on it |
| Transaction limits | The Supabase docs show a client-level Vitest suite that mirrors the pgTAP tests, and note that application-level tests cannot use a rolled-back transaction | `beyond-transactions.md` and an optional client-level test template |
| Evidence file | No machine-readable evidence file found in the files read | `tap-to-evidence.mjs`, schema aligned with `test-gate` |

## Using it with `supabase-rls-policies`

[`supabase-rls-policies`](https://github.com/github/awesome-copilot/blob/e593e6649d3b538772b7329b26bcd626b54900ff/skills/supabase-rls-policies/SKILL.md) (`github/awesome-copilot`, read at commit `e593e6649d`) is a complementary skill, not a competitor. It helps you **write** policies well: a `to` clause on every policy, the owner bound in `with check`, `app_metadata` instead of `user_metadata`, `security_invoker` views, an MFA (`aal2`) restrictive policy and indexes on policy columns. It also includes a two-user pgTAP test template. `pgtap-rls` **proves** the policies across the whole schema: an automated mutation check (policies and grant denials), catalog-wide RLS coverage, pinned policy sets, function checks read from the catalog, `service_role` as a setup role, unique ids per file, the evidence file and a client-level sign-in template. Policy design stays out of scope here, so using both is a sensible setup: write with one, verify with the other.

Three test patterns in `pgtap-rls` 0.3.0 come from that file, and we thank its authors for them:
- **Unfiltered UPDATE/DELETE probes** for the other user (no `where`, `returning 1`), so a correct SELECT policy cannot hide a too-open write policy. We also confirmed it with a mutation run (see `references/VERSIONS.md`).
- **Owner transfer**: the other user cannot move their own row to the owner (`42501`, only `with check` stops it).
- **Full claims at every switch** for policies that read `auth.jwt()`, with an `aal1` denied / `aal2` allowed pair.

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

- Scripts: `node --test` (38 tests) on Node 26, Windows.
- SQL templates and reference snippets: ran green on a local Supabase stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0) on 2026-11-12; the optional client-level template is not run yet. `skills/pgtap-rls/references/VERSIONS.md` has the list.
- Agents: not yet tested in Claude Code or another agent (see `CHECKLIST.md`).
- Written for Supabase CLI 3.1.0 / Postgres 17.

## License

Apache-2.0
