# __NAME__

[![skills.sh](https://www.skills.sh/b/AndresDiagoM/agent-testing-skills)](https://www.skills.sh/andresdiagom/agent-testing-skills) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE) [![Version 0.1.0](https://img.shields.io/badge/version-0.1.0-green)](CHANGELOG.md)

__DESCRIPTION__

## Before / after

TODO: one real "before" (what an agent did without the skill) and what the skill makes it do. Only measured numbers; if there is no measured "after", say so.

## Measured results

TODO: `claude plugin eval` results (trigger/negative pass rate, quality deltas), date, model and plugin version. Say which cases show no gain.

## Usage

In Claude Code, type `/__NAME__:__NAME__` (plugin install) or `/__NAME__` (skill-folder install), or ask in plain words:

- TODO: 4-6 example prompts.

Not for: TODO (copy from the `description`).

## What you get

TODO: real, trimmed output (a file, a report) produced by running the skill or its scripts on a fixture. Say it is trimmed.

## Problems this solves

- TODO

## Install

Claude Code:
```
/plugin marketplace add AndresDiagoM/agent-testing-skills
/plugin install __NAME__@agent-testing-skills
```

Other agents ([Agent Skills](https://agentskills.io) standard), with the [`skills`](https://github.com/vercel-labs/skills) CLI pinned to the version we tested:
```
npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill __NAME__
```

## Updating and uninstalling

```
/plugin marketplace update agent-testing-skills
/plugin update __NAME__@agent-testing-skills
/plugin uninstall __NAME__@agent-testing-skills
```
Outside a session: `claude plugin marketplace update agent-testing-skills`, then `claude plugin update __NAME__@agent-testing-skills`. Restart to apply. With `npx`: re-run the `add` command. What changed: [CHANGELOG.md](CHANGELOG.md).

## When something goes wrong

- **The skill does not load:** type `/__NAME__:__NAME__` (or `/__NAME__`) or say "use the __NAME__ skill".
- **It loads for a task it should not:** see "Not for" in Usage, and report it.
- **Anything else:** https://github.com/AndresDiagoM/agent-testing-skills/issues

## Tested with

- [ ] Claude Code: `claude plugin eval` (date)
- [ ] opencode / Codex / other: ___

## Privacy and network

TODO: what the skill and its scripts read, write and send (normally: nothing leaves the machine). Must match the repo's [PRIVACY.md](../../PRIVACY.md).

## Contributing and changelog

- Contributing: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0
