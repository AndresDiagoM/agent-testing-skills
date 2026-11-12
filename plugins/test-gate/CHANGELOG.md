# Changelog

## 0.2.0 (2026-11-12)

- Kit: `install.mjs` (dry-run by default), `e2e-changed.mjs` + map, Claude Code Stop hook, Playwright templates (setup project, `gotoReady`, config snippet with `repeatEach` from `E2E_REPEAT`, build-id preflight) and Next.js readiness markers + health route.
- `e2e-guard.mjs` redesigned: diff mode against the merge-base, in-hunk `// test-guard: approved <reason>` approvals, new rules (fewer assertions or tests, removed test files, `only`, larger timeouts, new retries, `expect(...).catch`, tautologies, `toPass`, literal secrets); `--all` + ratchet baseline kept; `approvals.json` removed.
- `scripts/install-global.mjs`: one copy in `~/.agents/skills`, links for Claude Code and opencode, Antigravity `skills.json`.
- `gate.mjs` exports `E2E_SERVER_COMMAND`; Directory metadata and icon.
- Tested on two real projects' scratch copies (Windows + WSL); 155 `node:test` tests. Evals: trigger/negative 24/24; quality cases with-plugin 0.97-1.00 (deltas +0.73, +0.17, +0.13; `q-random-login` still does not discriminate).

## 0.1.0 (2026-11-12)

- `SKILL.md` with 14 always-on rules, five-step procedure and a reference routing table.
- References: gate-run, evidence-schema, e2e-auth, e2e-waiting, flaky-and-skips, servers-builds-windows, supervision (with brief template), repo-rules-overrides (with paste-ready block), cypress-jest (not verified against a local repo), versions.
- Kit core: `gate.mjs`, `e2e-guard.mjs`, evidence schema v2 (68 `node:test` tests).
- Eval cases: trigger-1..4 and negative-1..4 (24/24 runs pass), quality Q1-Q4 (with-plugin 1.00 each; two do not yet discriminate from the baseline). Q5 needs WSL2 Bash and is not included yet.
- Not in this version (planned for 0.2): kit app templates, Stop hook, kit installer, `e2e-changed`, global install helper.
