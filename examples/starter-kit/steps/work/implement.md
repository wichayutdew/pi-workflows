Implement the approved plan in the bound worktree.

Request: `{{workflow.input}}`
Approved plan: `{{reviewed.artifact}}`
Feedback: `{{reviewed.feedback}}`
Ledger: `{{last.summary}}`

Stay in `repositories[0].cwd`. Run only `worker` commands. Use TDD only for tests listed with an assessable benefit. Do not add tests to justify extra code. Leave pre-existing dirty files alone. Do not push, open reviews, or mutate Jira.

Work in bounded passes. At the start of each pass, inspect the bound worktree, approved plan, original request, and previous handoff. Select and complete at least one smallest coherent feature directly supported by the approved plan or request. Commit and test it before returning.

A parent recovery `handoff` is unconfirmed context, not evidence of completed work. Reconcile the bound worktree, approved plan, request, and ledger before selecting the next slice; never infer a commit, test result, or feature completion from it.

When approved work remains after the committed feature, return `handoff` with the commit and verification evidence in `completed` and exact remaining approved work in `remaining`. Use `blocked` only for a real missing prerequisite, authority, or unrecoverable blocker.

`handoff`: one coherent committed and tested slice remains incomplete.
`ready`: every approved implementation slice is complete, with red/green evidence and commits.
`blocked`: missing authority, prerequisite, or unrecoverable blocker.
