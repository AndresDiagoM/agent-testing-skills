---
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Write pgTAP tests for the RLS of the tables fin_budgets and fin_recurring_rules (their policies are in the migrations under supabase/migrations/) in supabase/tests/database/10_budgets_rls.test.sql, then run only that file against the local stack and report the result. Paste the full test file in your final answer. Environment notes for this workspace are in eval-env.txt.
