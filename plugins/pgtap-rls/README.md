# pgtap-rls

[![skills.sh](https://www.skills.sh/b/AndresDiagoM/agent-testing-skills)](https://www.skills.sh/andresdiagom/agent-testing-skills)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Version 0.3.1](https://img.shields.io/badge/version-0.3.1-blue)

An agent skill that writes, reviews and runs pgTAP tests for Supabase/Postgres Row Level Security (RLS) policies, grants and SQL functions, and records the result as machine-readable evidence.

## Before / after

Before: a "deny" test that cannot fail. RLS filters an UPDATE to zero rows and raises no error, so this passes whether the policy is correct or wide open.

```sql
select lives_ok($$update public.zz_notes set body = 'hacked' where id = '...'$$, 'other user cannot update');
```

After (from `assets/policy-matrix.test.sql`): an unfiltered probe that reads no column, so a correct SELECT policy cannot hide a too-open UPDATE policy, then a re-read as the owner.

```sql
select is_empty($$update public.zz_notes set body = 'hacked' returning 1$$, 'other user UPDATE touches 0 rows (unfiltered, no column read)');
-- ... then, as the owner:
select is((select body from public.zz_notes where id = '11a00000-0000-0000-0000-000000000001'), 'edited', 'owner row survived the other user attempts unchanged');
```

The mutation check (`scripts/mutate-test.mjs`) then adds a temporary `using (true)` policy in a scratch copy and the deny test must turn red. If it stays green, the test is vacuous.

## Measured results

`claude plugin eval` with Sonnet, 2026-11-12 (raw files are in `evals/results/`, which is git-ignored; summary in [evals/README.md](evals/README.md)):

- Trigger and negative cases: 24/24 runs pass (4 trigger and 4 negative cases, 3 runs each). The skill loads on pgTAP/RLS prompts and stays out of Playwright, policy-writing, slow-query and Vitest prompts.
- Quality, one run per arm against a real local Supabase stack: Q3 +0.75 (1.00 with the skill, 0.25 without) and Q4 +0.40 (1.00 and 0.60). An earlier Q3 run scored 0.25 with the skill, so one run is a weak signal.
- Q1 and Q2 scored the same with and without the skill (rubric fails in both arms). Q5 failed in both arms because Bash could not start in the sandbox. These three are still open.
- These runs loaded plugin version 0.1.0; later versions were not re-evaluated.
- Mutation runs on a live stack: with the old filtered probes, an UPDATE-only or DELETE-only policy mutation left the deny tests green. With the unfiltered probes both turn red. Details in `skills/pgtap-rls/references/VERSIONS.md`.

## What you get

`scripts/tap-to-evidence.mjs` turns `supabase test db` output into a `db:test` step in `.gate/last.json`. Real output from a captured CLI 3.1.0 run (one wrong expectation in a 22-test file), trimmed:

```json
{
  "name": "db:test",
  "kind": "db",
  "status": "failed",
  "command": "supabase test db",
  "exitCode": 1,
  "counts": { "passed": 21, "failed": 1, "skipped": 0, "files": 1, "tests": 22, "result": "FAIL" },
  "scope": { "kind": "all" },
  "reportedBy": "pgtap-rls 0.3.1",
  "failures": [
    { "test": "A does not see B portfolios", "file": "/work/scratch/01_rls_wrong.test.sql",
      "number": 2, "have": "0", "want": "1" }
  ],
  "details": { "pgtap": { "result": "FAIL", "skipsVisible": false,
    "statusReasons": ["exit code 1", "Result: FAIL", "1 failed test(s)"] } }
}
```

Fields such as `finishedAt`, `wallMs`, `timeoutMs`, `logFile` and `message` are left out here. `skipped` is 0 because the CLI output does not show skips (`skipsVisible: false`).

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
npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill pgtap-rls
```

`npx skills` installs into `.claude/skills` and `.agents/skills`. We checked this for `test-gate` on 2026-11-12; `pgtap-rls` uses the same mechanism. Other Agent Skills agents are not tested yet.

## Usage

In Claude Code, type `/pgtap-rls:pgtap-rls` (plugin install) or `/pgtap-rls` (skill-folder install), or ask in plain words. Example prompts:

- "Add pgTAP tests proving user B can't read or update user A's rows in `notes`."
- "Audit the RLS policies in my latest migration and write tests for them."
- "`supabase test db` fails on 01_rls.test.sql, test 7. Help me fix it."
- "Is my `get_balance(uuid)` security definer function safe? Write tests for who can call it."

Not for: Playwright/e2e or Vitest/Jest tests, query performance, or designing the policies themselves.

Scripts (Node 20+, no dependencies, no network): `node skills/pgtap-rls/scripts/tap-to-evidence.mjs --help`, `node skills/pgtap-rls/scripts/mutate-test.mjs --help`.

## Updating and uninstalling

Claude Code (restart it to apply an update):
```
/plugin marketplace update agent-testing-skills
/plugin update pgtap-rls@agent-testing-skills
/plugin uninstall pgtap-rls@agent-testing-skills
```
Outside a session, the same commands work as `claude plugin marketplace update agent-testing-skills`, `claude plugin update …` and `claude plugin uninstall …`. If you installed with `npx skills`, delete the `pgtap-rls` folder from `.claude/skills` and `.agents/skills`, and install again to update. What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## When something goes wrong

- **The skill does not load.** Type `/pgtap-rls:pgtap-rls` (or `/pgtap-rls`), or say "use the pgtap-rls skill". Check that the plugin shows as installed in `/plugin`, and restart Claude Code after an install or update.
- **`supabase test db` output is not parsed.** `tap-to-evidence.mjs` never records a pass it cannot confirm: a missing `Files=N, Tests=M` summary, `Result: NOTESTS` (no test files), zero tests, a plan mismatch or a died file all give `status: "failed"`, and `details.pgtap.statusReasons` says why. Parsing a saved log needs `--command` and `--exit-code`.
- **Anything else.** Open an issue: https://github.com/AndresDiagoM/agent-testing-skills/issues

## Tested with

- Scripts: `node --test` (38 tests, all passing) on Node 26, Windows.
- SQL templates and reference snippets: ran green on a local Supabase stack (Postgres 17.11, pgTAP 1.3.3, CLI 3.1.0) on 2026-11-12; the optional client-level template ran against a local stack with Vitest 5 and supabase-js. `skills/pgtap-rls/references/VERSIONS.md` has the list.
- Agents: the trigger and quality evals ran in Claude Code (`claude plugin eval`, Sonnet) on 2026-11-12. Other agents are not tested yet (see `CHECKLIST.md`).
- Written for Supabase CLI 3.1.0 / Postgres 17.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0
