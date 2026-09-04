Implement the approved plan in the bound worktree.

Request: `{{workflow.input}}`
Approved plan: `{{reviewed.artifact}}`
Feedback: `{{reviewed.feedback}}`
Ledger: `{{last.summary}}`

Stay in `repositories[0].cwd`. Run only `worker` commands. Use TDD only for tests listed with an assessable benefit. Do not add tests to justify extra code. Leave pre-existing dirty files alone. Do not push, open reviews, or mutate Jira.

Work in bounded checkpoints. At the start of each pass, inspect the bound worktree, approved plan, original request, and previous handoff. Select and complete at least one smallest coherent feature directly supported by the approved plan or request. Commit and test it before returning. For `checkpoint`, include `progress` with the completed feature, commit, changed files, RED/GREEN verification, and exact remaining approved work.

A parent recovery `handoff` is unconfirmed context, not evidence of completed work. Reconcile the bound worktree, approved plan, request, and ledger before selecting the next slice; never infer a commit, test result, or feature completion from it.

When approved work remains after the committed feature, return `checkpoint`; do not attempt further slices. Use `blocked` only for a real missing prerequisite, authority, or unrecoverable blocker.

`checkpoint`: red/green evidence and a commit for one coherent slice; remaining approved work is explicitly listed in the handoff.
`ready`: every approved implementation slice is complete, with red/green evidence and commits. Pass the JSON contract unchanged.
`retry`: transient tool failure requiring no user input.
`blocked`: missing authority, prerequisite, or unrecoverable blocker.
