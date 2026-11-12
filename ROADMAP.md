# Roadmap

## v0.1 (in progress, started 2026-11-12)

**test-gate**
- `SKILL.md` (< 5 KB, 14 rules) and the 10 references of `specs/test-gate.md` section 4.
- Evidence schema v2 (`evidence-schema.md` + `evidence.schema.json`), aligned with pgtap-rls (spec 4.2.5).
- Kit core in `assets/kit/`: `gate.mjs`, `gate-lib.mjs` (+ `node:test` tests), `e2e-guard.mjs` with ratchet baseline, `kit.config.example.json`, `add-step`.
- Evals: trigger/negative cases and quality cases Q1-Q4 (Q5 needs WSL2 Bash, run if time allows).
- Install test of the kit core on a scratch copy of the reference project.

**pgtap-rls**
- `SKILL.md` (< 5 KB, 14 rules), 9 references, `VERSIONS.md`.
- Assets: `test-skeleton.test.sql`, `policy-matrix.test.sql`, `rls-coverage.test.sql`, optional `client-rls.test.ts.tmpl`.
- Scripts: `tap-to-evidence.mjs`, `mutate-test.mjs` (+ `node:test` tests).
- Evals: trigger/negative cases and quality cases Q1-Q5 (Q1-Q5 need the reference project's Supabase stack up).

**Repo**
- Discoverability in-repo parts (`specs/DISCOVERABILITY.md` phase 1).

## v0.2 (planned)

**test-gate**
- Kit app templates: `goto-ready.ts`, `auth.setup.ts`, `playwright.config.snippet.ts`, `preflight.ts`, `app/{hydration-marker,page-ready,with-page-ready}.tsx`.
- `e2e-changed.mjs` with `e2e-changed.map.json`.
- Parameterised Stop hook (`hooks/stop-gate.mjs` + `settings.snippet.json`).
- `install.mjs` for the kit (dry-run by default) and `install-global.mjs`.
- Global install recipe: one copy in `~/.agents/skills/test-gate`, links for Claude Code and opencode, Antigravity `skills.json`, and a short pointer in each agent's global rules file. Verify each agent lists the skill in a real session.
- Real install in a second project (WSL, Next front + NestJS back): decide the e2e command and whether `playwright.config.ts` changes (`npm run dev` + `reuseExistingServer: true`); guard baseline 87/13/77/6.
- Tier B evals on real repos (project A B1-B3, project B).
- The reference project's own gate scripts adopt schema v2.
- Align `e2e-guard.mjs` with the reference project's new `pnpm test:guard`: diff against the merge-base, blocks fewer assertions/tests, removed files, `skip`/`fixme`/`only`, larger timeouts, new retries, `expect(...).catch`, tautological assertions; approvals only via `// test-guard: approved <reason>` added in the same hunk. Decide whether the kit adopts that design (diff mode + inline approvals) instead of `approvals.json`.

**pgtap-rls**
- Done in v0.1 (2026-11-12): real CLI 3.1.0 captures, assets and recipes verified live (Postgres 17.11, pgTAP 1.3.3), `auth.uid()` source confirmed.
- Still to verify: `client-rls.test.ts.tmpl`, Basejump notes, `--workdir`, real captures of zero-files and verbose output.
- Quality evals Q1-Q5 need a `case.yaml` + fixture that copies `supabase/` into the eval workspace and uses the running stack.
- Test in a non-Claude agent (opencode or Codex).
- `SKILL.md` is at 5118/5120 bytes: trim before adding anything.

**Evals (both)**
- `quality-diagnose-random-login` and `quality-flaky-without-weakening` show delta 0 (the baseline already passes): make them harder so they discriminate.
- Add tags to pgtap-rls cases so `--tag` works.

**Evidence schema**
- Decide the `scope: files` rule: the kit applies it only to required steps; the spec said it always forces `complete:false`.
- The honesty rule rejects `passed` with a non-zero exit, which a mutation step hits; pgtap-rls works around it (`kind: custom`, real exit in `details`). Consider a first-class mutation step kind.

**Repo**
- Publish to GitHub, `npx skills` check, Anthropic directory submission (METODOLOGIA phases 3-5).
- Discoverability phases 2-3 (`specs/DISCOVERABILITY.md`).
