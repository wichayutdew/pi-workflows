Create a concrete implementation plan from the inspected feedback.

Include scope, exact files or symbols, risks, and verification. Account for prior review feedback:

{{gate.feedback}}

Include one fenced `json` verification contract with a top-level
`repositories` array. Put exact standalone implementation commands under
`worker[].command` and independent commands under `reviewer[].command`.

When the plan is ready, call `workflow_complete_step` with outcome `submit` and
place the full Markdown plan in `artifact`. The Plannotator gate decides the
next transition; its reviewed artifact becomes the next step's handoff.
