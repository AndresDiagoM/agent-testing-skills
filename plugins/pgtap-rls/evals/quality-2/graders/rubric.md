---
type: llm
weight: 2
---

PASS if the agent finds at least three weaknesses (for example anon with a previous user's claims, a count of 0 on a table never seeded, lives_ok as the only check of a denied UPDATE/DELETE, no re-read of the victim row); adds a positive control, a row-count check and a re-read; runs the mutation check showing the ORIGINAL stays green (vacuous) and the fixed file goes red; deletes the scratch copy; and touches no migration or policy.
FAIL if it declares the file fine because it is green, adds more lives_ok, edits a policy, or skips the mutation step.
