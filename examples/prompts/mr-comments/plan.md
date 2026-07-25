Create a concrete implementation plan from the inspected feedback.

Include scope, exact files or symbols, risks, and verification. Account for prior review feedback:

{{gate.feedback}}

Include one fenced `json` verification contract with a top-level
`repositories` array. Every repository entry must contain its exact absolute
`cwd`; this workflow requires one distinct repository directory. Put exact
standalone implementation commands under `worker[].command` and independent
commands under `reviewer[].command`. Resolve any TDD setup, test selection, or
command limitation in this reviewed contract; later steps must not invent
another prerequisite or ask for clarification.

When the plan is ready, call `structured_output` with a `value` whose outcome
is `submit` and whose `artifact` is the full Markdown plan. The Plannotator gate
decides the next transition; its reviewed artifact becomes the next step's
handoff.
