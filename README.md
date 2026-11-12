# Agent skills for honest, fast testing

Agent Skills (the open [SKILL.md](https://agentskills.io) format) that make coding agents (Claude Code, Codex, opencode, Antigravity, Cursor) run tests quickly, prove what they ran, and test database security for real. Each skill is also a Claude Code plugin.

## Which skill solves which problem

| Problem | Skill |
|---|---|
| An agent runs the e2e suite again and again, or splits it into batches with `sleep` to dodge a rate limit | [test-gate](plugins/test-gate) |
| Every e2e test logs in through the UI and hits the auth rate limit (Supabase: 30 sign-ins per 5 min) | [test-gate](plugins/test-gate) |
| An agent "fixes" a flaky test with retries, `test.fixme`, `skip`, a broader locator or a longer timeout | [test-gate](plugins/test-gate) |
| Tests click before React hydration; agents reach for `networkidle` or `waitForTimeout` | [test-gate](plugins/test-gate) |
| A subagent has been running the gate for 40 minutes and nobody checks its log | [test-gate](plugins/test-gate) |
| "All tests pass" in prose, with no command, exit code or counts to check | [test-gate](plugins/test-gate) |
| Playwright on Windows stalls in 10 s steps with 2+ bundled Chromium; a stale server is reused | [test-gate](plugins/test-gate) |
| You need pgTAP tests for Supabase Row Level Security: anon, owner, other user, service_role | [pgtap-rls](plugins/pgtap-rls) |
| An UPDATE or DELETE denied by RLS returns no error and 0 rows, so the test passes for the wrong reason | [pgtap-rls](plugins/pgtap-rls) |
| You want proof an RLS test can fail, and checks for `security definer` functions, `search_path` and grants | [pgtap-rls](plugins/pgtap-rls) |

Why these exist and what other testing skills leave out: [docs/why.md](docs/why.md).

## Install

Claude Code:
```
/plugin marketplace add AndresDiagoM/agent-testing-skills
/plugin install test-gate@agent-testing-skills
/plugin install pgtap-rls@agent-testing-skills
```

Other agents ([Agent Skills](https://agentskills.io) standard, via [`skills`](https://github.com/vercel-labs/skills)):
```
npx skills add AndresDiagoM/agent-testing-skills --skill test-gate
npx skills add AndresDiagoM/agent-testing-skills --skill pgtap-rls
```

## Skills

| Skill | What it does | Version |
|---|---|---|
| [test-gate](plugins/test-gate) | Run and supervise quality gates (lint, typecheck, unit, DB, build, e2e) in JS/TS projects with machine-readable evidence | 0.1.0 (in progress) |
| [pgtap-rls](plugins/pgtap-rls) | pgTAP tests for Supabase/Postgres Row Level Security, grants and SQL functions | 0.1.0 (in progress) |

## Contributing a skill

Follow [METODOLOGIA.md](METODOLOGIA.md) (Spanish). Roadmap: [ROADMAP.md](ROADMAP.md).

```sh
node scripts/new-skill.mjs my-skill "What it does and when to use it"
node scripts/check-skill.mjs my-skill
claude --plugin-dir ./plugins/my-skill
claude plugin eval ./plugins/my-skill
```

## License

Apache-2.0
