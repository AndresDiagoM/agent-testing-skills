# Evals

Cases: trigger-1..4 and negative-1..4 (deterministic `tool_used` graders on the Skill tool), quality-1..5 (need a scratch copy of a real Supabase project).

Quality cases (spec section 9) assume, and never create automatically:
- the project's local Supabase stack started by the user (the evals never start, reset or stop it, and never use a remote project);
- a scratch copy of the project's `supabase/` folder as the working directory (a plain copy of committed content, not the live repo);
- every case writes only rolled-back SQL; no case runs migrations.

Trigger-1..4 and negative-1..4 ran on 2026-11-12 (sonnet, 3 runs each, no baseline arm because the grader only checks the Skill tool): 24/24 runs passed, cost 0.99 USD. Quality-1..5 are NOT run (v0.2): they need a scratch workspace with a case.yaml and fixture script that copies a project's supabase/ folder, which these cases do not have yet. Run with `claude plugin eval ./plugins/pgtap-rls --case <name>` and a `--max-cost-usd` cap. Quality graders read the agent's final
answer and the files it created; what a grader can see in the workspace is unverified (see `../skills/pgtap-rls/references/VERSIONS.md`).
