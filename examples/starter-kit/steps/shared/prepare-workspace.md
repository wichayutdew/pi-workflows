You prepare the Git workspace for a user-owned workflow. This prompt—not the
workflow harness—owns every Git and worktree decision.

Request:
{{workflow.input}}

Run ID:
{{run.id}}

Inspect the current Git root, registered worktrees, branch, HEAD, repository
instructions, and `git status --short` before changing anything. Preserve every
existing file, branch, worktree, commit, and uncommitted change.

Compute one stable short run marker from the run ID and require it in both the
dedicated branch and worktree name. Before selecting the current checkout or
deriving a new name, search every registered worktree and branch for that
marker.

If exactly one branch/worktree pair is owned by this run, validate its canonical
path, registered branch, and containment inside `workspace.allowedRoots`, then
reuse it. Reuse it even when it is dirty and even when this step was launched
from a different primary or linked worktree. Its current HEAD and uncommitted
state are resumable work that must be preserved. If the current checkout is
that exact pair, this rule naturally selects it. A dirty exact run-owned
worktree is resumable and must never cause a replacement workspace.

Never reuse the current checkout merely because it is a linked worktree or is
on a non-default branch. It is the source checkout unless it matches the exact
run marker. This prevents an unrelated earlier task worktree from replacing
this run's already-created target.

Only when no exact run-owned pair exists, derive a concise task branch and
adjacent worktree path containing the marker. Create the new pair from the
exact source HEAD observed by this step, regardless of whether the source
checkout is primary or linked. Before mutation, prove the target canonicalizes
inside an allowed root and does not belong to unrelated work.

Be idempotent. Complete a safe partial setup only when the marker identifies
one unambiguous branch/path pair. Block on multiple matches, mismatched
branch/path ownership, or an unrelated collision. Never create a second
workspace for one run.

Do not reset, clean, delete, overwrite, force, stash, commit, fetch, push, edit
project files, or repurpose an existing path. If a branch/path collision or
ambiguous partial setup makes reuse unsafe, finish with `blocked`.

After creation or reuse, verify that the selected path is an absolute,
registered Git worktree on the intended named branch and that the source
checkout was not changed. Call `structured_output` alone with outcome `ready`,
a self-contained evidence summary, and:

```json
{ "cwd": "/absolute/path/to/the/selected/worktree" }
```

Place that object in the result's `workspace` field, not in the summary alone.
Use `blocked` without `workspace` when preparation cannot be made safe.
