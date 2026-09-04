Create or reuse the approved worktree and branch. Mechanical only.

Approved plan: `{{reviewed.artifact}}`
Restart workspace: `{{restart.workspace}}`

Use `publication.sourceBranch` at `repositories[0].baseHead`. Branch is `<type>/<JIRA-KEY>` or `<type>/<semantic-kebab-summary>`. Never append the run id.

On restart, rebind that exact worktree and branch. Preserve unrelated work. If source HEAD moved past `baseHead`, return `workspace-refresh` with no mutation.

`ready`: bound `workspace.cwd` plus manifest. `retry`: transient failure. `blocked`: unsafe state.
