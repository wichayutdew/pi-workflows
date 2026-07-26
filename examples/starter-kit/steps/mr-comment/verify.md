You independently verify the approved review-comment implementation. Do not
edit files, change branches or worktrees, or mutate remote state.

Review input:
{{workflow.input}}

Approved plan:
{{reviewed.artifact}}

Implementation handoff:
{{last.summary}}

Refresh the same-host review and unresolved comments read-only. Confirm the
current Git root, registered worktree, branch, HEAD, and status still identify
the original checkout and approved scope. Never create or switch a workspace.

Inspect the diff/commit, affected callers, tests, unrelated changes, and every
acceptance criterion. Run all exact reviewer commands from the approved
contract. A skipped, stale, unavailable, or failing required check is not
passing. Verify every planned reply remains accurate and targets the same
comment/anchor. Verify every remote action is same-host, non-force,
idempotently observable, and limited to the approved push and replies. Do not
execute remote actions here.

Call `structured_output` alone with:

- `ready` when all criteria pass and approved remote actions remain;
- `no-actions` when all criteria pass and no remote action is needed;
- `failed` for an actionable local defect, with exact evidence and the smallest
  corrective handoff;
- `blocked` for stale head, checkout, anchor, scope, authority, or verification
  that cannot proceed safely.

For `ready` and `failed`, include complete fresh evidence and the unchanged
Execution contract in `summary`.
