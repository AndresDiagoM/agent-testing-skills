# Running the suite and recording evidence

## Command
Resolve it from the repo, in order: the `package.json` script (`db:test` or `test:db`, run with the repo's package
manager), else `supabase test db`. One file: append its path (`supabase test db supabase/tests/database/10_x.test.sql`).
Never add `--remote` or `--linked`; never reset, push or recreate the database. Prerequisite: the local stack is up.
If it is down, report that and stop. Do not start it unless the repo rules or the user say so.

## Wrap the run
```
node <skill>/scripts/tap-to-evidence.mjs run [--timeout-min 10] [--evidence .gate/last.json] -- <command...>
```
It refuses `--remote`, `--linked`, `db reset`, `db push`, `down -v`, `--force-reset`; tees the output to
`.gate/logs/db-test.log`; kills the process tree on timeout; parses; and merges ONE step. From an existing log:
`node <skill>/scripts/tap-to-evidence.mjs parse --log <file> --command "<cmd>" --exit-code N --wall-ms N`
(`--command` and `--exit-code` are required: without an exit code the step cannot be `passed`).
`--dry-run` prints the merged JSON without writing. `--required lint,db:test` sets `requiredSteps` when the file has none.
If the repo has the `test-gate` kit (`scripts/gate.mjs` at the repo root, or `--gate <path>`), the step is merged by
`gate.mjs add-step`, so test-gate applies its own rules; otherwise the script uses a built-in copy of the same rules
(`--no-gate` forces it; a test cross-checks both). If the kit's own gate already ran `db:test`, do not record it twice.

## Evidence rules
- Writes the step `db:test`, `kind: "db"`, into the shared file (schema v2 of `test-gate`, `reportedBy: "pgtap-rls 0.1.0"`).
  Other steps and root fields survive; the same-name step is replaced whole; the write is atomic.
- `counts`: numbers `passed`, `failed`, `skipped` (the schema's minimum) plus the legacy pgTAP keys `files`, `tests`,
  `result`; the same three also sit in `details.pgtap` with `skipsVisible`. `skipped` is 0 when the output cannot show
  skips: the CLI's pg_prove output is not verbose, so a `skip()` is counted among `Tests=` and never appears
  (captured 2026-11-12). `details.pgtap.skipsVisible: false` says so; do not read that 0 as "no skips".
- `failures[]`: `{ test, file?, message, number?, have?, want? }` (no null fields: the schema wants strings).
- `ok` and `complete` are test-gate's: `ok` = every recorded step passed or was skipped; `complete` also needs every
  `requiredSteps` entry fresh, passed in scope `all`, no unapproved skips, and a non-empty `requiredSteps`.
- `db:test:mutation` (`--mutation`) is a `custom` step, not a test run: `passed` means the mutated copy went red as
  expected. test-gate rejects a `passed` step with a non-zero exit code, so a detected mutation records `exitCode: 0`;
  the real pg_prove exit code is in `details.pgtap.mutation.pgProveExitCode`. A surviving mutation is `failed` (`ok` false).
- `status` is `failed` for: non-zero exit, `Result: FAIL`, zero files, zero tests, plan mismatch, a file that died,
  parse errors, unparsable output. A timeout is `timeout`.
- `--scope-files a,b` (a re-run of failing files) records `scope.kind: "files"`: a required step with that scope is never
  `complete`, so finish with one full run.
- Skips need approval: `--approved-skips <json>` with `approvedBy` `user` or `orchestrator` and an `approvalRef`.

## Reading pg_prove output
Closing line `Files=N, Tests=M, ... wallclock secs` then `Result: PASS|FAIL`. Per failure `# Failed test N: "name"`
with `have:` and `want:` lines; `Test Summary Report` lists `Failed test:` numbers and `Parse errors:` (bad plan).
Captured from CLI 3.1.0 (`scripts/test/fixtures/cli-*`): the CLI prints the summary on stdout and the Target
line, psql NOTICE/ERROR lines and `error running container: exit 1` on stderr; there are no `ok N` lines and no `n/m`
counters. A file that dies prints `Dubious, test returned 3` on its own line and `(Wstat: 768 (exited 3) ...)` in the
summary. `supabase test db <file>` accepts a file outside `supabase/` (Windows, verified). Through plain `psql -f` the
exit code is 0 even when tests fail: read the `not ok` lines.

## Report
Command, exit code, wall time, files and tests, passed/failed/skipped, failing tests with file and number,
mutation-check result per deny-test group, discrepancies found (`coverage-and-mutation.md`), and what pgTAP could
not show (`beyond-transactions.md`). Prose such as "tests pass" does not count as evidence.
Supervision: a run beyond about 30 minutes is inspected by reading the log, not waited on.
