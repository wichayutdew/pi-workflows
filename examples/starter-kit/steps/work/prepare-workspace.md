You prepare the approved branch after the plan gate. Do not launch subagents.

Approved plan: {{reviewed.artifact}}
Restart workspace: {{restart.workspace}}

Create or reuse only the approved `publication.sourceBranch` at approved `repositories[0].baseHead`. The run ID is for ownership/idempotence lookup only and must never be appended to a branch name. Branches are `<type>/<JIRA-KEY>` for verified Jira or `<type>/<semantic-kebab-summary>` otherwise; reject random numbers, timestamps, hashes, and recomputed names.

If `{{restart.workspace}}` is set, rebind that exact worktree and existing branch; block if it differs from the approved branch. Preserve user changes and unrelated worktrees. If source HEAD advanced from approved baseHead, return `workspace-refresh` without mutation. Return `ready` with bound workspace path and manifest, `retry` only for transient failures, and `blocked` for unsafe state.
