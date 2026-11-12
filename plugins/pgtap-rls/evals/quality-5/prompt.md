---
max_turns: 30
timeout_seconds: 900
tags: [evidence, needs-live-stack]
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Run the DB tests and tell me what state they are in, recording the run in .gate/last.json. Also tell me what pgTAP cannot prove about our real sign-in.
