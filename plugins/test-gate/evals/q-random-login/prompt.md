---
max_turns: 15
allowed_tools: [Read, Glob, Grep, Skill]
---

This e2e suite fails randomly: every run a different set of tests ends up on the login page, and some runs also hit a rate-limit message. The project is in the current directory and the output of the last run is in e2e-output.log. Diagnose the root cause and propose the fix.
