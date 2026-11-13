# Privacy policy

Applies to every plugin and skill in this repository (`test-gate`, `pgtap-rls`). Last updated: 2026-11-12.

## What is collected

Nothing. The author does not collect, receive, store or share any data from people who install or use these plugins.

## How the plugins work

- The skills are Markdown instructions that your coding agent reads on your machine.
- The optional scripts and templates (for example `assets/kit/` in `test-gate`, `scripts/` in `pgtap-rls`) run locally with Node.js or `psql`, only when you or your agent run them.
- They make no network calls of their own, send no telemetry and contain no analytics.
- They read files in your repository (such as `package.json`, test output and SQL files) and write evidence files inside it (such as `.gate/last.json`). That data stays on your machine.
- Test templates may read credentials from your own environment variables at test time. They are never sent anywhere by these plugins.

## Third parties

Your coding agent (for example Claude Code) and the tools your repository runs (test runners, databases, browsers) have their own privacy terms. This repository does not change how they handle data.

## Contact

Open an issue at https://github.com/AndresDiagoM/agent-testing-skills/issues.
