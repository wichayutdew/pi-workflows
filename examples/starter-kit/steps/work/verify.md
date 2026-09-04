Independently check the implementation against the approved goal and acceptance criteria. Read-only.

Request: `{{workflow.input}}`
Approved plan: `{{reviewed.artifact}}`
Feedback: `{{reviewed.feedback}}`
Ledger: `{{last.summary}}`

Re-run `repositories[0].reviewer[]`. Confirm commit title, status vs dirty baseline, and each acceptance criterion. A skipped or failing check is a fail.

`passed`: criteria and checks hold.
`failed`: return to implement with the exact gap.
`retry`: transient read-only failure.
`blocked`: corrupted workspace.
