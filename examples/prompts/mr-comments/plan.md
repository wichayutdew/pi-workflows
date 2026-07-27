Create a concrete, decision-ready implementation plan from the inspected
feedback. The previously rejected artifact is:

{{gate.artifact}}

Account for previous Plannotator feedback:

{{gate.feedback}}

When feedback is non-empty, revise the rejected artifact and submit the complete
proposal for another review. Each rejection returns to this same planning step.

Write the artifact for a human reviewer first. Use this order:

# <Short outcome-oriented title>

## Review summary

In three to five plain-language bullets, explain the desired result, why it
matters, what is in scope, and what is deliberately out of scope.

## Review focus

List only choices that materially affect behavior, scope, risk, or an
irreversible action. For each choice, give the recommendation, useful
alternatives, and consequence. Say `No decisions needed` when there are none.

## Proposed changes

Use a short numbered list. Name the exact file or symbol, state its observable
change and reason, and give the corresponding acceptance criterion. Use
checkboxes only for acceptance criteria, not for scope, evidence, risks, or
every sentence.

## Validation

Explain the focused and independent checks in reviewer language. State what
each check proves; keep exact shell metadata out of this narrative.

## Risks

List only material risks, with a concrete safeguard or rollback signal for
each. Cite decisive evidence inline instead of dumping raw exploration logs or
labeling every bullet `FACT`, `HYPOTHESIS`, or `UNKNOWN`.

Do not leave `UNKNOWN`, `TBD`, or implementation-time research in the plan. If
the allowed resources cannot resolve required access, provenance, repository
state, resource identity, or targets, complete with `blocked` instead of
submitting an incomplete plan. A user choice may remain only in Review focus
with evidence and an adopted recommendation.

When ready, call `structured_output` with a `value` whose outcome is `submit`
and whose `artifact` is the full Markdown plan. This format is defined by this
workflow prompt; Pi Workflows treats the artifact as opaque.
