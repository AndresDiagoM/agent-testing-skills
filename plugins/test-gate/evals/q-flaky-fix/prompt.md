---
max_turns: 15
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit]
---

e2e/reports.spec.ts fails randomly (see e2e-failures.log): sometimes the Export button is ambiguous, sometimes the click does nothing and the status never changes. Fix this flaky test.
