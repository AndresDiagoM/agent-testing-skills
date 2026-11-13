# Repo rules win; Basejump is optional

## Precedence
Repo rules (`AGENTS.md`, `.claude/rules/*`, `.agents/rules/*`) > a repo-local `OVERRIDES.md` next to the skill > this
skill. Policy design belongs to the official `supabase` and `supabase-postgres-best-practices` skills; this skill
owns tests. If a finding is a design question, say so in the report and hand it back.

## OVERRIDES.md template
```
# Overrides for pgtap-rls (repo rules win)
- Overridden: "<exact section of the skill>"
  Reason: <repo rule and where it is written>
  Instead: <what to do here>
```
Likely entries: the repo forbids new extensions inside test files; the repo uses Basejump helpers.

## Basejump `supabase_test_helpers` (optional, documentation only)
A community add-on, installed through dbdev, not meant to be enabled in production (enable it inside the test
suite). Functions: `tests.create_supabase_user(identifier, email, phone)`, `tests.authenticate_as(identifier)`,
`tests.authenticate_as_service_role()`, `tests.clear_authentication()`, `tests.rls_enabled(schema[, table])`,
`tests.get_supabase_uid(identifier)`. Equivalences: `authenticate_as(x)` = the three statements of
`impersonation.md`; `tests.rls_enabled('public')` = `assets/rls-coverage.test.sql.md`. Version pinning is inconsistent
in the sources, so this skill pins nothing. The skill's templates never call `tests.*`, and no Basejump variant of
them exists, because two recipes would contradict each other.
