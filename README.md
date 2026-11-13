# Agent skills for honest, fast testing

[![skills.sh](https://www.skills.sh/b/AndresDiagoM/agent-testing-skills)](https://www.skills.sh/andresdiagom/agent-testing-skills) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/AndresDiagoM/agent-testing-skills)

Agent Skills (the open [SKILL.md](https://agentskills.io) format) that make coding agents (Claude Code, Codex, opencode, Antigravity, Cursor) run tests quickly, prove what they ran, and test database security for real. Each skill is also a Claude Code plugin.

**Why:** an agent once spent 1 h 41 min on an e2e gate whose tests took about 30 s per batch. Every test logged in through the UI, hit the auth rate limit, and the agent split the suite into batches with 5-minute sleeps instead of fixing the cause. `test-gate` makes the agent log in once, run each gate once with a time cap, and leave a `.gate/last.json` you can check. `pgtap-rls` does the same for database security: RLS tests that can fail, and proof that they do.

## Which skill solves which problem

| Problem | Skill |
|---|---|
| An agent runs the e2e suite again and again, or splits it into batches with `sleep` to dodge a rate limit | [test-gate](plugins/test-gate) |
| Every e2e test logs in through the UI and hits the auth rate limit (Supabase CLI local default: 30 sign-ups or sign-ins per 5 min per IP) | [test-gate](plugins/test-gate) |
| An agent "fixes" a flaky test with retries, `test.fixme`, `skip`, a broader locator or a longer timeout | [test-gate](plugins/test-gate) |
| Tests click before React hydration; agents reach for `networkidle` or `waitForTimeout` | [test-gate](plugins/test-gate) |
| A subagent has been running the gate for 40 minutes and nobody checks its log | [test-gate](plugins/test-gate) |
| "All tests pass" in prose, with no command, exit code or counts to check | [test-gate](plugins/test-gate) |
| Playwright on Windows stalls in 10 s steps with 2+ bundled Chromium; a stale server is reused | [test-gate](plugins/test-gate) |
| You need pgTAP tests for Supabase Row Level Security: anon, owner, other user, service_role | [pgtap-rls](plugins/pgtap-rls) |
| An UPDATE or DELETE denied by RLS returns no error and 0 rows, so the test passes for the wrong reason | [pgtap-rls](plugins/pgtap-rls) |
| You want proof an RLS test can fail, and checks for `security definer` functions, `search_path` and grants | [pgtap-rls](plugins/pgtap-rls) |

Why these exist, and how they relate to other testing skills and guides (with sources and commits): [docs/why.md](docs/why.md).

## Install

Claude Code:
```
/plugin marketplace add AndresDiagoM/agent-testing-skills
/plugin install test-gate@agent-testing-skills
/plugin install pgtap-rls@agent-testing-skills
```

Other agents ([Agent Skills](https://agentskills.io) standard, via [`skills`](https://github.com/vercel-labs/skills), version pinned to the one we tested):
```
npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill test-gate
npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill pgtap-rls
```

Then ask your agent, for example: "run the gate", "why is this e2e test flaky?", or "write pgTAP tests proving user B can't update user A's notes". In Claude Code you can also type `/test-gate:test-gate` or `/pgtap-rls:pgtap-rls` (plugin install; `/test-gate` or `/pgtap-rls` for a skill-folder install). Each skill's README has more examples, updating and troubleshooting.

## Skills

| Skill | What it does | Version |
|---|---|---|
| [test-gate](plugins/test-gate) | Run and supervise quality gates (lint, typecheck, unit, DB, build, e2e) in JS/TS projects with machine-readable evidence | 0.2.1 |
| [pgtap-rls](plugins/pgtap-rls) | pgTAP tests for Supabase/Postgres Row Level Security, grants and SQL functions | 0.3.1 |

Both skills share one evidence format (`.gate/last.json`), so a DB test step written by `pgtap-rls` shows up in the same gate report as `test-gate`'s steps.

## Privacy

No data is collected. The skills are Markdown; the optional scripts run locally, make no network calls and send no telemetry. See [PRIVACY.md](PRIVACY.md).

## Contributing

Bug reports, fixes and new skills are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Roadmap: [ROADMAP.md](ROADMAP.md).

## License

[Apache-2.0](LICENSE)
