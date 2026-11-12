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
| TAP parser vs real CLI output (`scripts/test/fixtures/cli-*`) | pass (14 files, 370 tests), fail, plan mismatch, died, skip captured; two parser gaps found and fixed |

Fixes made because of the run: `discover.md` used `'auth.uid'::regprocedure` (errors; now `'auth.uid()'`), the parser
missed `(Wstat: 768 (exited 3) ...)` summaries and the standalone `Dubious` line, and the mutation doc now says UPDATE/DELETE
mutations need `--cmd all` when SELECT hides the row.

## Verified in the v0.2 round (2026-11-12, same stack, disposable project copy)
| Item | Result |
|---|---|
| `assets/client-rls.test.ts.tmpl` | Instantiated for one table (`portfolios`) in a disposable copy with Vitest 5 + supabase-js: 5/5 tests green against the local stack (admin `createUser`, two real `signInWithPassword`, empty-list read, zero-row update, `42501` on foreign insert, anon). Two users created, two deleted in `afterAll`; `auth.users` count identical before and after, no `rls-%` leftovers. Fixes made from the run: unique run prefix in the e-mail (`rls-<runId>-<label>`), `seedRow` hook for other NOT NULL columns (the table needed `kind`), header says verified |
| Keys | `supabase status -o env` printed `PUBLISHABLE_KEY` and `SECRET_KEY` (besides `ANON_KEY`, `SERVICE_ROLE_KEY`); the template's `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` map to them. Read them in the real project folder; `status` wrote nothing there (mtimes unchanged) |
| `--workdir <dir>` | CLI 3.1.0: "used exactly as given, no ancestor search"; test paths resolve against it. It does NOT make a copy reuse a running stack by itself: the Docker network and container names come from the linked project ref of the stack, not from the copy's `config.toml` `project_id`, so a plain copy fails with `network supabase_network_<project_id> not found`. Working recipe: `supabase test db --network-id supabase_network_<ref> <paths>` (needs no `supabase/.temp`); get `<ref>` from `docker ps --filter name=supabase_db_` |
| Zero-file run (real) | `supabase test db <empty dir>`: exit 1; stdout `Files=0, Tests=0 ... Result: NOTESTS`; stderr `no pgTAP tests found in <dir>`. Captured as `scripts/test/fixtures/cli-zero.{out,err}`; the parser reads `NOTESTS` as `UNKNOWN` and the step is `failed` for any exit code |
| Evals under WSL2 | Bash-granting evals do not run on native Windows (no sandbox backend). On Ubuntu 22.04 WSL2 they ran after: `bwrap` + `socat` unpacked from the `.deb` files into `~/.local/bin` (no root), a `HOME` without symlinks under `~/.docker` (the sandbox refuses a Docker store that contains symlinks), and a Linux `supabase` 3.1.0 CLI on `PATH`. The workspace in `/tmp` works with the Docker Desktop socket |

## Still UNVERIFIED
- Basejump `supabase_test_helpers`.
- Verbose output (`verbose.txt` stays synthetic: the CLI has no `-v`; `zero.txt` is synthetic too, the real zero-file capture is `cli-zero.*`).
- Behaviour in agents other than Claude Code.

Re-check this table at every release and update the date.
