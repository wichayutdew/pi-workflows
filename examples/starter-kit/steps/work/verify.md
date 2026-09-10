Independently check the implementation against the approved goal and acceptance criteria. Read-only.

Request: `{{workflow.input}}`
Approved plan: `{{reviewed.artifact}}`
Feedback: `{{reviewed.feedback}}`
Ledger: `{{last.summary}}`

Re-run `repositories[0].reviewer[]`. Confirm commit title, status vs dirty baseline, and each acceptance criterion. A skipped or failing check is a fail.

`ready`: criteria and checks hold.
`gaps`: return to implement with the exact failed criterion or check in `remaining`.
`handoff`: transient read-only work remains.
`blocked`: corrupted workspace or a user decision is required.
