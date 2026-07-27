You prepare the Git workspace for a user-owned workflow. This prompt—not the
workflow harness—owns every Git and worktree decision.

Request:
{{workflow.input}}

Run ID:
{{run.id}}

Inspect the current Git root, registered worktrees, branch, HEAD, repository
instructions, and `git status --short` before changing anything. Preserve every
existing file, branch, worktree, commit, and uncommitted change.

On a first visit, the current non-run checkout is the source checkout. On a
later visit from the already bound run-owned worktree, recover the original
source checkout and local source branch/ref from the previous-step workspace
manifest, then validate both against current Git registration. Never treat the
run-owned target as its own source merely because it is now the child cwd. If a
later visit has no trustworthy source identity, use `blocked` rather than
guessing a default branch. Capture the source branch/ref and its exact local
HEAD; that commit is the intended base for this preparation attempt. Do not
fetch, pull, or infer a remote base.

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

After selecting the exact run-owned worktree, inspect its current HEAD, status,
operation state, upstream/remote reachability, and ancestry against the
captured local source HEAD:

- When the captured source HEAD is already an ancestor of the selected HEAD,
  preserve the selected HEAD. Target-only commits are legitimate resumable
  workflow work, not a stale workspace, so rebasing would be a no-op.
- When the source HEAD is not an ancestor and the selected worktree is dirty,
  preserve it without stashing or rebasing. Report `rebase: deferred-dirty`
  with the exact source and selected state. A later planner must work from that
  recorded state and must not bounce back for the same source snapshot.
- When the source HEAD is not an ancestor, the selected worktree is clean, and
  no Git operation is active, rebase only the exact run-owned branch onto the
  captured local source HEAD. First prove that the commits being rewritten are
  local, unpublished, linear run-owned work and that no unrelated ref will be
  updated. Do not rewrite published, signed, merge, or unrelated history.
- If that rebase conflicts or fails after it starts, do not resolve project
  files or continue it. Abort only the rebase started by this attempt, verify
  that the exact pre-attempt selected HEAD and status were restored, and use
  `blocked` with the conflict and rollback evidence. If restoration cannot be
  proven, preserve all recovery state and report it without further mutation.

Do not reset, clean, delete, overwrite, force, stash, commit, fetch, pull, push,
edit project files, update unrelated refs, or repurpose an existing path. The
only history rewrite authorized here is the guarded rebase of the exact
run-owned branch above; the only rollback is aborting that same in-progress
rebase. If a branch/path collision or ambiguous partial setup makes reuse
unsafe, finish with `blocked`.

After creation or reuse, verify that the selected path is an absolute,
registered Git worktree on the intended named branch and that the source
checkout was not changed. Call `structured_output` alone with outcome `ready`,
a self-contained workspace manifest containing the source path, branch/ref and
captured HEAD; selected path, branch and before/after HEAD; ancestry before and
after; `rebase: not-needed | completed | deferred-dirty`; initial and final
status; and exact verification evidence. Include:

```json
{ "cwd": "/absolute/path/to/the/selected/worktree" }
```

Place that object in the result's `workspace` field, not in the summary alone.
Use `blocked` without `workspace` when preparation cannot be made safe.
