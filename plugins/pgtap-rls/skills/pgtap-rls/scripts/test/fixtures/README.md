# Fixtures

## Real captures (CLI 3.1.0)
`cli-<name>.out` and `cli-<name>.err` are captured from `supabase test db` (Supabase CLI 3.1.0, local stack, Windows, 2026-11-12). The
CLI prints the pg_prove summary on stdout (`cli-<name>.out`) and the Target line, psql NOTICE/ERROR lines and
`error running container: exit 1` on stderr (`cli-<name>.err`). `tap-to-evidence run` logs both streams; the tests
append the stderr file to the stdout file to emulate that log.

| Capture | How it was produced | Exit |
|---|---|---|
| `pass` | `pnpm db:test` in a real project: 14 files, 370 tests | 0 |
| `fail` | a temp copy of one real test file with one wrong expectation, run as `supabase test db <path outside supabase/>` | 1 |
| `plan` | temp file `plan(5)` with 4 assertions | 1 |
| `died` | temp file that selects from a missing table | 1 |
| `skip` | temp file with `skip('not today', 1)`: exit 0, `Tests=3`, no sign of the skip in the output | 0 |
| `zero` | `supabase test db <empty dir>`: stdout `Files=0, Tests=0` + `Result: NOTESTS`, stderr `no pgTAP tests found in <dir>` | 1 |

Facts these captures settled: the default output has no `ok N` lines and no `n/m` progress counters (a failing file shows
`<path> ..` then the `# Failed test` block, then `Failed 1/22 subtests` on its own line), so skips are invisible and
`counts.skipped` is 0 by construction; `supabase test db <path>` accepts a file outside `supabase/` on Windows; the
printed path has the drive letter stripped (`/Users/...`).
Paths, the user name and the linked project name were replaced with `/work/...` and `<linked project>`; nothing else was edited.

## Synthetic
`all-pass.txt`, `one-fail.txt`, `plan-bad.txt`, `died-mid.txt`, `zero.txt`, `garbage.txt`: default-style
output written by hand from the pg_prove / TAP::Harness format (they show the `n/m` progress form of an interactive
terminal, which the CLI does not emit when piped). `verbose.txt`: verbose (`-v`) output with an `ok N # skip` line:
the CLI has no `-v`, so this form needs a direct `pg_prove -v`. `ansi-crlf.txt`: `all-pass.txt` with ANSI colour codes
and CRLF. The real zero-file output is `cli-zero.*`.
