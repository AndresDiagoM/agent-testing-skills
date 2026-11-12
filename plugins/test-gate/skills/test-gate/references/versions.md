# Versions: what the tips were verified against

Read 2026-11-12 from lockfiles and `package.json` (no suite was run for this table). A tip tagged "verified against X" holds for that version; on a newer or older one, re-check before relying on it.

| Item | Project A (Next 16, Supabase, Windows) | Project B front (Next 16, WSL) | Project B back (NestJS, WSL) |
|---|---|---|---|
| Playwright (`@playwright/test`) | 1.65.0 (lockfile) | 1.60.0 (lockfile) | 1.61.1 (lockfile) |
| Vitest | 5.1.0 (lockfile) | 4.0.18 (lockfile) | not found |
| Jest | none | none | 29.7.0 (lockfile) |
| Cypress | none | none | none |
| Next.js | 16.4.6 (lockfile) | not re-read | n/a |
| Supabase CLI | 3.1.0 (lockfile) | n/a | n/a |
| tsx | 4.23.15 (lockfile) | n/a | n/a |
| Package manager | pnpm 12.18.0 (`packageManager`) | not re-read | not re-read |
| Node | `engines` >=26, `.nvmrc` 26 | not re-read | not re-read |

## Kit templates (assets/kit/e2e and assets/kit/app)

Checked 2026-11-12 in a disposable copy of project A (no server, no database, no suite run):

| Check | Result |
|---|---|
| Type-check of all kit `.ts` and `.tsx` files with the copy's own `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) | no errors in the kit files |
| `playwright test --list` with a config importing `playwright.config.snippet.ts`, a `kit.config.json` with two roles and two per-spec users | 5 tests listed in 2 projects, exit 0 |
| Versions in that copy's lockfile | Playwright 1.65.0, Next 16.4.6, React 19.3.1, TypeScript 6.0.3, `@types/node` 26.6.6 |

Not checked: a real browser run of `gotoReady`, `auth.setup.ts` or `preflight.ts`, and a Next build with the app templates (the reference project's equivalent files run in its own suite).

## Which tips carry which tag

- Setup project, `dependencies`, `storageState`, `channel: 'chrome'` on Windows, one worker: Playwright 1.65.0, measured in the reference project config and runs, 2026-11-12. The kit config snippet carries the same choices (see the table above).
- Ready helper with `data-hydrated` and `data-page-ready`: Playwright 1.65.0 and Next 16.4.6, reference project.
- Not verified here: Playwright `--repeat-each`, `--shuffle`, the `json` reporter and `--outputFile` flags; Vitest and Jest `--json` flags; every Cypress statement. Check with the installed version's `--help`.

## Re-check commands

Use the repo's manager (see the gate-run recipe in SKILL.md's table):

- Lockfile entry: search the lockfile for the package name and read the resolved version (for example the entry for `@playwright/test@`).
- Installed version: the manager's exec form of `playwright --version`, `vitest --version`.
- Package manager and Node: the `packageManager` and `engines` fields in `package.json`, and `.nvmrc`.

Update this file, with a new date, whenever a tip is re-verified.
