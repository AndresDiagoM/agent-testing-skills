---
type: llm
weight: 2
---

PASS if the test file: reads the migrations or catalog first; uses two users with ids unique to this file; has an allow case and a deny case for select, insert, update and delete as owner, other user and anon; has a positive control next to each deny case; asserts silent UPDATE/DELETE denials with a zero-row check AND re-reads the row as its owner; and has an exact plan(N). The agent ran only that file, then the full suite at most once.
FAIL if it only reads rows as the owner, omits anon, uses only lives_ok for denials, reuses ids from other files, runs db reset or --remote, repeats full runs after each edit, or contains a JWT-shaped string.
