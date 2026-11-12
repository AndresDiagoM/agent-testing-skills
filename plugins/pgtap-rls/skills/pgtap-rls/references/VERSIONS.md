# Versions and verification status (2026-11-12)

Verified on 2026-11-12 on the local Supabase stack of a real project (Docker, Windows 11), in rolled-back
transactions. Nothing was migrated, reset or committed.

| Item | Value | Status |
|---|---|---|
| Supabase CLI | 3.1.0; `supabase test db [<path...>]` | VERIFIED: ran; a path outside `supabase/` works (Windows) |
| Postgres | 17.11 (`select version()`) | VERIFIED |
| pgTAP | default 1.3.3, installed only when a test file runs `create extension if not exists pgtap with schema extensions` (lands in `extensions`; `pgtap_version()` prints `1.3`) | VERIFIED |
| Basejump `supabase_test_helpers` | optional; pin inconsistent in sources | UNVERIFIED, not pinned (not on the stack) |
| Scripts | Node 20+ (tested on Node 26), zero dependencies | `node --test` 38/38 (includes a cross-check with the test-gate kit) |
| `auth.uid()` | reads `request.jwt.claim.sub` first, then `request.jwt.claims ->> 'sub'`; both work | VERIFIED (`pg_get_functiondef`, then behaviour) |

## Snippets run against the live stack (2026-11-12)
| Snippet | Result |
|---|---|
| `assets/test-skeleton.test.sql` | green (1/1) |
| `assets/policy-matrix.test.sql` | green (19/19): unfiltered `is_empty(... update/delete ... returning 1)`, owner transfer, `policies_are`, `policy_cmd_is` |
| `assets/claims-aal2.test.sql` | green (10/10): restrictive `aal2` policy, full claims per switch, claims guards, sub-only trap |
| `assets/rls-coverage.test.sql` | real schema: test 2 flags `ingestion_runs` (RLS on, no policy, `service_role` only); allowlisted: 3/3 green |
| Impersonation recipe, `jsonb_build_object(...)::text` claims | works; `auth.uid()`/`auth.role()` read it |
| Stale-claims and temp-table-without-grant (`42501`) pitfalls | both reproduced |
| `is_definer`, `isnt_definer`, `function_owner_is`, `function_privs_are`, `table_privs_are`, `policy_roles_are`, `security_invoker` and `search_path` checks | green on real functions, tables, a view |
| `mutate-test.mjs` on a real file (CLI copy outside `supabase/`, and `docker exec psql`) | select: 8 of 22 red; insert with `--grant insert`: deny test red; update-only stayed green (SELECT hides the row), `--cmd all` turned update/delete deny tests red; original byte-identical (sha256) |
| TAP parser vs real CLI output (`scripts/test/fixtures/cli-*`) | pass (14 files, 370 tests), fail, plan mismatch, died, skip; two parser gaps found and fixed |

## v0.3 round (2026-11-12, same stack, `docker exec psql`, `mutate-test.mjs` output in a temp dir)
Mutation on `policy-matrix.test.sql` (line moved after the policies, since the table is created in the file):
| Mutation | Old filtered probes (v0.2) | Unfiltered probes (v0.3) |
|---|---|---|
| UPDATE only (`--cmd update`) | deny tests green (17 ok; only `policies_are` red) | red: other-user UPDATE, owner transfer, owner re-read (+ `policies_are`) |
| DELETE only (`--cmd delete`) | deny tests green (same) | red: other-user DELETE, owner re-read, `service_role` read (row deleted) (+ `policies_are`) |
| INSERT (`--cmd insert`) | not run | red: forged insert (+ `policies_are`) |
| SELECT (`--cmd select`) | not run | red: other user sees the owner row (+ `policies_are`) |
| UPDATE `with check (true)` only (hand-written) | not run | red: owner transfer only (+ `policies_are`) |
Owner positive controls (tests 1-6) stayed green every time. `claims-aal2.test.sql`: dropping or loosening the
restrictive policy turned the aal1 read, aal1 insert, sub-only and final count tests red (4 of 10); a permissive
`using (true)` (M1) turned only the other-user test red: the aal1 denials stayed green, restrictive policies still AND.

## Verified in the v0.2 round (2026-11-12, disposable project copy)
| Item | Result |
|---|---|
| `assets/client-rls.test.ts.tmpl` | Vitest 5 + supabase-js, one table: 5/5 green on the local stack (admin `createUser`, two `signInWithPassword`, empty read, zero-row update, `42501` foreign insert, anon). Cleanup checked. Fixes: unique run prefix in the e-mail, `seedRow` hook |
| Keys | `supabase status -o env` prints `PUBLISHABLE_KEY` and `SECRET_KEY` (besides the legacy two); the template's env vars map to them |
| `--workdir <dir>` | used exactly as given, no ancestor search; does NOT reuse a running stack by itself (network and container names come from the linked project ref). Recipe: `supabase test db --network-id supabase_network_<ref> <paths>`; `<ref>` from `docker ps --filter name=supabase_db_` |
| Zero-file run | `supabase test db <empty dir>`: exit 1, `Result: NOTESTS`, stderr `no pgTAP tests found`. Fixture `cli-zero.*`; parsed as `UNKNOWN`, step `failed` |
| Evals under WSL2 | Bash evals need WSL2 (no native Windows sandbox): `bwrap` + `socat` in `~/.local/bin`, no symlinks under `~/.docker`, Linux `supabase` 3.1.0 on `PATH`, workspace in `/tmp` |

## Still UNVERIFIED
- Basejump `supabase_test_helpers`.
- Verbose output (`verbose.txt` stays synthetic: the CLI has no `-v`; `zero.txt` too, the real capture is `cli-zero.*`).
- Behaviour in agents other than Claude Code.

Re-check this table at every release.
