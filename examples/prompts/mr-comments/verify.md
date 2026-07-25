Review the implementation against the requested merge-request feedback and approved plan.

Inspect the diff and run each exact reviewed reviewer command with its enclosing
`repositories[].cwd`, plus the static allow-list. Do not ask a terminal
question. Complete with `passed` only when evidence supports completion.
Complete with `failed` to return to implementation and preserve the exact
fenced JSON contract in the summary, or `blocked` when the workflow or
environment must be repaired.
