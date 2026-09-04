Plan the work from intake. Read-only. Do not create a branch or worktree.

Authoritative work request: `{{workflow.input}}`
Intake/recovery handoff: `{{last.summary}}`
Rejected plan: `{{gate.artifact}}`
Feedback: `{{gate.feedback}}`

Inspect origin, base HEAD, target branch, and the host description template.

Submit exactly:

# <Outcome title>
## Goal/Acceptance Criteria
## Non Goal
## Implementation Steps and Tests
Add/remove steps only. List a test only when it has an assessable benefit.
## Validation
Exact independent Bash commands and expected proof.
## Risks/Decisions Needed
## Publications Contract/Metadata
Observed provider/repository/target, source branch, semantic title, description template, traceability mode, Jira key or null. Jira mode: exactly one `[KEY]` in the title. Requirement mode: no bracketed key.
## Execution appendix (machine-readable)
JSON: `repositories` (`sourceRoot`, `baseHead`, `branch`, `worker`, `reviewer`), `traceability`, `publication` (`provider`, `repository`, `sourceBranch`, `targetBranch`, `title`, `descriptionTemplate`, `managedDescription`).

Branch: `<type>/<KEY>` or `<type>/<semantic-kebab-summary>`. No random suffix or run id. `submit` only after metadata is observed.
