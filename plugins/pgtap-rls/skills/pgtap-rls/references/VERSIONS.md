# Versions and verification status (2026-11-12)

Verified on 2026-11-12 against the local Supabase stack of a real project (Docker, Windows 11), inside rolled-back
transactions and with the project's own read-only `db:test` script. Nothing was migrated, reset or committed.

| Item | Value | Status |
|---|---|---|
| Supabase CLI | 3.1.0; `supabase test db [<path...>]` | VERIFIED: ran; a path outside `supabase/` works (Windows) |
| Postgres | 17.11 (`select version()`) | VERIFIED |
| pgTAP | extension default version 1.3.3, not installed until a test file runs `create extension if not exists pgtap with schema extensions` (it lands in `extensions`; `pgtap_version()` prints `1.3`) | VERIFIED |
| Basejump `supabase_test_helpers` | optional; pin inconsistent in sources | UNVERIFIED, not pinned (not on the stack) |
| Scripts | Node 20+ (tested on Node 26), zero dependencies | `node --test` 37/37 (includes a cross-check with the test-gate kit) |
| `auth.uid()` | reads `request.jwt.claim.sub` first, then `request.jwt.claims ->> 'sub'`; both forms work | VERIFIED (`pg_get_functiondef`, then behaviour) |

## Snippets run against the live stack (2026-11-12)
| Snippet | Result |
|---|---|
| `assets/test-skeleton.test.sql` | green (1/1) |
| `assets/policy-matrix.test.sql` | green (18/18), includes `is_empty(... update/delete ... returning 1)`, `policies_are`, `policy_cmd_is(... 'UPDATE')` |
| `assets/rls-coverage.test.sql` | on the real schema: test 2 flags `ingestion_runs` (RLS on, no policy, written by `service_role` only); allowlisting it makes 3/3 green; tests 1 and 3 green |
| Impersonation recipe (`reset role; set_config(claims, ..., true); set local role ...`), `jsonb_build_object(...)::text` claims | works; `auth.uid()`/`auth.role()` read it |
| Stale-claims pitfall, temp-table-without-grant `42501` pitfall (`impersonation.md`) | both reproduced |
| `is_definer`, `isnt_definer`, `function_owner_is`, `function_privs_are` (`array['uuid','jsonb']`, `array[]::text[]`), `table_privs_are`, `policy_roles_are`, `security_invoker` check, `search_path` check | green on real functions, tables and a view |
| `mutate-test.mjs` on a real test file, run with `supabase test db <copy outside supabase/>` and through `docker exec psql` | select-mutation: 8 of 22 red incl. the "sees only own / does not see B" tests, 14 green; insert-mutation with `--grant insert`: the deny test red; update-only mutation stayed green (SELECT policy hides the row), `--cmd all` turned update/delete deny tests red; original byte-identical (sha256) |
| TAP parser vs real CLI output (`scripts/test/fixtures/real-cli-3.1.0-*`) | pass (14 files, 370 tests), fail, plan mismatch, died, skip captured; two parser gaps found and fixed |

Fixes made because of the run: `discover.md` used `'auth.uid'::regprocedure` (errors; now `'auth.uid()'`), the parser
missed `(Wstat: 768 (exited 3) ...)` summaries and the standalone `Dubious` line, and the mutation doc now says UPDATE/DELETE
mutations need `--cmd all` when SELECT hides the row.

## Still UNVERIFIED
- `assets/client-rls.test.ts.tmpl` (Vitest + supabase-js): needs a scratch install and the stack's API keys; v0.2.
- Basejump `supabase_test_helpers`.
- Reusing a running stack with `--workdir` on a scratch copy (the CLI here resolves the stack from the repo; not tried).
- Real CLI capture of a zero-file run (`zero-files.txt` stays synthetic) and of verbose output (`verbose-skip.txt`: the CLI has no `-v`).
- Behaviour in agents other than Claude Code.

Re-check this table at every release and update the date.
