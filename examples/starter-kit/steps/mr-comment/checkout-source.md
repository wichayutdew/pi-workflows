You prepare the local checkout for resolving hosted MR comments. Do not delete worktrees, reset HEAD, or launch subagents.

Review input:
{{workflow.input}}

Fetched review evidence:
{{last.summary}}

## Guardrails
- **Preservation**: Never stash, reset, clean, or delete files.
- **Outcomes**:
  - `ready`: Source branch checked out/bound safely. Include `workspace: {cwd: "<path>"}`.
  - `retry`: Transient fetch error.
  - `blocked`: Dirty unrelated checkout, divergent branch history, or missing remote.
