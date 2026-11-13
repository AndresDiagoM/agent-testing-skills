# Fast and isolated suites

- **No reset per test or per file.** The suite is `begin ... rollback` against one migrated database. Never use
  `db reset` (slow, blocks parallel runs). Re-run one file with `supabase test db <path>` (CLI 3.1.0 accepts
  `[<path...>]`, checked with `--help`).
- **Ids unique per file.** First UUID group = file number, last character = actor: file `10`:
  `10000000-0000-0000-0000-00000000000a` (owner), `...0b` (other). Reusing the same ids in many files is safe only
  because every file rolls back and files run sequentially; a parallel run or a leaked `commit` would collide.
- **Fixtures inside the file.** Create them in the file's transaction; never assert counts of seed data (an
  `is(count, 10)` on a seeded catalog breaks when the seed changes). If a test needs an empty table, empty it inside
  the transaction, or use far-future dates or a unique prefix.
- **Tiny fixtures.** Use realistic row counts only when a policy has a subquery whose plan matters. Policy columns
  should be indexed (design belongs to the official Supabase skills).
- **Time budget.** The DB suite is one gate step with a timeout (default 10 minutes in `tap-to-evidence.mjs`). One
  file should take seconds; longer means it does seed work it should not.
- **One full run per gate.** Run the suite once; on a failure fix it, re-run only the failing file, then one final
  full run. Never split a suite into batches with sleeps: a limit or flake is a bug in the setup.
- **Symptoms to check first when slow or flaky:** shared data between files, a fixture that depends on another file,
  heavy triggers on `auth.users`, a missing index on a policy column.
