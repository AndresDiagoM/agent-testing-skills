# Changelog

## 0.1.0 (unreleased)

- First version: SKILL.md (14 rules), 9 references and `VERSIONS.md`.
- Assets: `test-skeleton.test.sql`, `policy-matrix.test.sql`, `rls-coverage.test.sql`, optional `client-rls.test.ts.tmpl`.
- Scripts: `tap-to-evidence.mjs` (writes the `db:test` step of the shared evidence file, schema v2) and `mutate-test.mjs`, with `node:test` tests.
- Evals: trigger-1..4, negative-1..4, quality-1..5 (not run yet).
- Known gaps: SQL snippets not run on a live stack; TAP fixtures are synthetic. See `skills/pgtap-rls/references/VERSIONS.md`.
