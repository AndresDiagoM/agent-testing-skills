# Changelog

## 0.3.1 (2026-11-12)

- Docs only, no behaviour change. README: before/after, measured eval results, usage, a real trimmed `db:test` evidence step, updating and uninstalling, troubleshooting, badges; "Tested with" corrected (evals ran in Claude Code; the client-level template ran green). `npx skills` pinned to 1.7.4.
- Manifest: `supportUrl`, `documentationUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` for the plugin directory.
- `SKILL.md` `metadata.version` and `tap-to-evidence.mjs` report 0.3.1; `running-and-evidence.md` no longer hard-codes a version.

## 0.3.0 (2026-11-12)

Three test patterns learned from [`github/awesome-copilot` `supabase-rls-policies`](https://github.com/github/awesome-copilot/blob/e593e6649d3b538772b7329b26bcd626b54900ff/skills/supabase-rls-policies/SKILL.md) (commit `e593e6649d`).
- Unfiltered write probes: the other user's UPDATE/DELETE probes are now `update t set col = 'x' returning 1` and `delete from t returning 1` with no `where`, while that user owns no rows (`assets/policy-matrix.test.sql`, `references/policy-matrix.md`). A column read applies the SELECT policy too, which hid a too-open UPDATE or DELETE policy. Verified: mutating only the UPDATE or only the DELETE policy now turns the deny test red; the old filtered probes stayed green. The reference says what to do when the other user must own rows.
- Owner transfer case: the other user inserts a row, then `update t set user_id = '<owner>'` with no `where` must raise `42501` (`with check`). `policy-matrix.test.sql` is now 19 tests.
- Claims-based and restrictive policies: `assets/claims-aal2.test.sql` (10 tests, temporary `aal2` restrictive policy, aal1 denied, aal2 allowed, positive control, claims guards, sub-only trap) and a section in `references/impersonation.md`: set the full `request.jwt.claims` at every switch. `coverage-and-mutation.md`: the permissive mutation cannot flip a restrictive denial, so edit the policy by hand; the mutation line goes after the policies for files that create their table inline.
- `SKILL.md` rule 7 and the template list updated (5113 bytes). `VERSIONS.md` records the mutation runs.
- Fix: `tap-to-evidence.mjs` reported `pgtap-rls 0.1.0` while `plugin.json` said 0.2.0, which failed the version test; the script and the test now match `plugin.json` (bump all three together).
- Docs: README and `docs/why.md` describe `supabase-rls-policies` as complementary and credit the patterns above.

## 0.2.0 (2026-11-12)

- `client-rls.test.ts.tmpl` verified with Vitest 5 + supabase-js against a local stack (unique user prefix per run, `seedRow` hook, cleanup checked).
- Real CLI 3.1.0 capture for zero test files (`Result: NOTESTS` is a failed step); shorter fixture names; `--workdir`/`--network-id` behaviour recorded in `VERSIONS.md`.
- Quality evals Q1-Q5 runnable (stage script copies `supabase/` and reuses the running stack; WSL2 needed for Bash). Q3 +0.75 and Q4 +0.40 over baseline; Q1, Q2 and Q5 still open.
- Directory metadata and icon; `repo-basejump.md` (renamed reference).

## 0.1.0 (2026-11-12)

- First version: SKILL.md (14 rules), 9 references and `VERSIONS.md`.
- Assets: `test-skeleton.test.sql`, `policy-matrix.test.sql`, `rls-coverage.test.sql`, optional `client-rls.test.ts.tmpl`.
- Scripts: `tap-to-evidence.mjs` (writes the `db:test` step of the shared evidence file, schema v2) and `mutate-test.mjs`, with `node:test` tests.
- Evals: trigger-1..4 and negative-1..4 (24/24 runs pass); quality-1..5 written, not run yet (planned for 0.2).
- Verified live on Postgres 17.11 + pgTAP 1.3.3 (Supabase CLI 3.1.0): assets and recipes; parser tests use real CLI captures. Still unverified: see `skills/pgtap-rls/references/VERSIONS.md`.
