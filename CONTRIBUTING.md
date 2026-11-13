# Contributing

Thanks for helping. Issues and pull requests are welcome at https://github.com/AndresDiagoM/agent-testing-skills.

## Reporting a problem

Open an issue with:
- the skill and version (`plugin.json`, or the `CHANGELOG.md` entry you installed);
- the agent and how you installed it (Claude Code plugin, `npx skills`, manual copy);
- what you asked the agent, what it did, and what you expected;
- for kit scripts: the command, its exit code and the relevant part of `.gate/last.json`. Remove secrets and private names first.

A skill that does not load when it should, or loads when it should not, is a bug too.

## Changing a skill

1. Keep `SKILL.md` short (under 500 lines) and put details in `references/`.
2. Only write what you verified. Name the tool versions you checked against in the skill's versions reference.
3. Examples carry no secrets, not even fake literal ones: read them from environment variables or generate them at run time. No destructive commands.
4. Run the checks before opening a pull request:
   ```sh
   node scripts/check-skill.mjs <skill> --portable
   claude plugin validate plugins/<skill> --profile directory
   claude plugin validate . --strict
   node --test plugins/test-gate/skills/test-gate/assets/kit/scripts/*.test.mjs plugins/test-gate/scripts/*.test.mjs   # test-gate
   node --test plugins/pgtap-rls/skills/pgtap-rls/scripts/test/*.test.mjs                                             # pgtap-rls
   ```
5. Rebuild the Anthropic directory edition and commit it: `node scripts/build-directory.mjs`, then `node scripts/build-directory.mjs --check` (it fails if `directory/` is stale or holds a file type the directory refuses). Never edit `directory/` by hand.
6. If behaviour changes, add or update an eval case in `plugins/<skill>/evals/` and run `claude plugin eval plugins/<skill>`.
7. Add a line to the skill's `CHANGELOG.md`. Maintainers bump the version and tag releases (`<skill>--vX.Y.Z`).

## Adding a skill

Follow [METODOLOGIA.md](METODOLOGIA.md) (Spanish): spec first, then build, evaluate and publish.

```sh
node scripts/new-skill.mjs my-skill "What it does and when to use it"
node scripts/check-skill.mjs my-skill
claude --plugin-dir ./plugins/my-skill
claude plugin eval ./plugins/my-skill
```

## License

By contributing you agree that your contribution is licensed under Apache-2.0, like the rest of the repository.
