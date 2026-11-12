# Roadmap

## v0.1.0 (released 2026-11-12)

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

## v0.2.0 (2026-11-12)

**test-gate**
- Done: kit templates (setup project, `gotoReady`, config snippet, preflight, readiness markers, health route), `e2e-changed.mjs` + map, Stop hook, `install.mjs`, `install-global.mjs`, `e2e-guard.mjs` redesigned (diff mode + in-hunk approvals, `approvals.json` removed).
- Done: global install on the author's machine (Claude Code loads it); kit tested on scratch copies of two real projects (Windows and WSL).

**pgtap-rls**
- Done: client template verified live, zero-files capture, `--workdir`/`--network-id` notes, quality evals Q1-Q5 runnable.

**Evals**
- Done: tags on every case, shorter paths, `q-flaky-fix` and `q-builder-brief` discriminate.

## v0.3 (planned)

**test-gate**
- `q-random-login` still scores 1.00 without the skill: find a case where the obvious fix is wrong in a way the baseline misses.
- Ratchet output: mark only the new hit, not every hit in the file whose count went up.
- Verify that Codex, opencode and Antigravity list and use the skill in a real session.
- Tier B evals on real repos with an agent session (run the gate, diagnose an injected flaky spec).
- Shorten the remaining long kit paths (longest is about 85 characters).

**pgtap-rls**
- Q1 and Q2: rubric fails in both arms; decide whether the rubric is too strict. Q5: Bash fails with "Failed to create bridge sockets" in the eval sandbox; diagnose.
- Basejump notes and verbose-output capture still unverified.
- Test in a non-Claude agent (opencode or Codex).
- `SKILL.md` is at 5104/5120 bytes: trim before adding anything.

**Evals (both)**
- Bash evals need WSL2 (no sandbox on native Windows) and must run one at a time.

**Evidence schema**
- Decide the `scope: files` rule: the kit applies it only to required steps; the spec said it always forces `complete:false`.
- A first-class mutation step kind (today pgtap-rls uses `kind: custom` with the real exit code in `details`).

**Repo**
- Anthropic directory submission (the author submits in the portal).
- Discoverability phases 2-3.
