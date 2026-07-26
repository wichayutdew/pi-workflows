Implement the approved plan with a small, coherent diff.

Approved review artifact:

{{reviewed.artifact}}

Use repository conventions and the allowed skill. Add or update focused tests
where practical. Treat the approved plan as the final contract. Apply TDD with
commands permitted by this step's declarative Bash allow-list. Do not perform
remote actions.
Complete with `ready` when implementation and focused checks are complete;
include a compact verification handoff in the summary.
Complete with `retry` when the approved contract remains valid and another
bounded attempt can safely continue unfinished work. The `replan` outcome is
unavailable. When the approved contract is missing, stale, contradictory, or
requires a material change to its targets or authority,
complete with `blocked` and preserve the existing worktree for follow-up.
