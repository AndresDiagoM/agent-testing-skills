# Evals

Cases: trigger-1..4 and negative-1..4 (deterministic `tool_used` graders on the Skill tool), quality-1..5 (run `supabase test db` against a real local stack). Tags: `trigger`, `negative`, `quality` (`claude plugin eval ./plugins/pgtap-rls --tag quality`).

## How the quality cases work
- `case.yaml` + `fixture.sh` per case; `_stage.sh` (shared, not a case) copies ONLY the `supabase/` folder of a disposable copy of a Supabase project into the empty eval workspace and writes `eval-env.txt` (the Docker network of the running stack and the allowed commands).
- The source copy is read from `RLS_EVAL_SRC` or, because scaffold scripts receive no `EVAL_*` variables, from the git-ignored file `.eval-work/rls-src.txt` at the repo root (one line, the path of the copy). Never point it at a live repo.
- Q1 removes the file that already covers the budget tables, Q2 and Q3 add a weak test (`10_weak_rls.test.sql`) and a contradicting test (`10_hypothetical_delete.test.sql`), Q4 removes the file that already covers the deposit function, Q5 runs the whole suite once and records `.gate/last.json`.
- Every case writes only rolled-back SQL or test files in the workspace. The evals never start, stop, reset or migrate the stack, never use `--remote` or `--linked`, and never touch the project folder. The reference project's stack must be started by the user.
- The stack is named after the linked project ref, not after the copy's `config.toml`, so the workspace (no linked project) needs `supabase test db --network-id <network> <paths>`; `eval-env.txt` says so.

## Running them (needs a sandbox)
Bash-granting evals do not run on native Windows (no sandbox backend). On WSL2 they need `bwrap` and `socat` on `PATH`, no symlink inside `~/.docker` (use a `HOME` without one), a Linux `supabase` CLI on `PATH` and Docker reachable from WSL. Details in `../skills/pgtap-rls/references/VERSIONS.md`.

```
claude plugin eval ./plugins/pgtap-rls --tag quality --scaffold --allow-tools Bash Write Edit --runs 1 --max-cost-usd 6
```

Trigger and negative cases need no scaffold or grants. Results go to `evals/results/` (git-ignored).

## Results (2026-11-12, sonnet, 1 run per arm, run alone: parallel evals break the sandbox bridge sockets)
| Case | With plugin | Baseline | Delta |
|---|---|---|---|
| quality-1 | 0.78 (rubric fails) | 0.78 | 0 |
| quality-2 | 0.60 (rubric fails) | 0.60 | 0 |
| quality-3 | 1.00 | 0.25 | +0.75 |
| quality-4 | 1.00 | 0.60 | +0.40 |
| quality-5 | 0.17 | 0.17 | 0 (Bash fails with "Failed to create bridge sockets" in both arms; not diagnosed) |

Total cost about 1.9 USD. Quality-1 and quality-2 reach the stack and write the files but the rubric judges the matrix or the mutation step incomplete in both arms.
