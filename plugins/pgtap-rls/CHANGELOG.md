# Changelog

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
