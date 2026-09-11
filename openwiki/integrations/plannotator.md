# Plannotator Integration

Plannotator is optional until a workflow step declares `gate`. Gated steps use
Plannotator for review submission and status polling; the workflow schema does
not support alternate gate providers.

Any gated step may submit an artifact. A delegated child returns it through
`structured_output`; a main-agent step uses `workflow_complete_step`. The step
prompt—not Pi Workflows—defines the artifact's format, purpose, acceptance
criteria, and downstream use. The integration transports that content without
parsing it or turning it into execution authority.

## Gate State Machine

```mermaid
stateDiagram-v2
  running --> awaiting_gate: step outcome = ready with artifact
  awaiting_gate --> running: rejection follows handoff
  awaiting_gate --> running: approval follows ready to next step
  awaiting_gate --> completed: approval follows ready to $done
  awaiting_gate --> paused: manual pause
  paused --> running: resume applies stored rejection
  paused --> running: resume applies stored approval to next step
  paused --> completed: resume applies stored approval to $done
```

## Gate Validation

```mermaid
flowchart TD
  Gate[gate config] --> Shape{timeoutMs and optional artifactContract only?}
  Shape -- no --> Reject[reject workflow]
  Shape -- yes --> Detect{Plannotator detectable?}
  Detect -- no --> Preflight[block step preflight]
  Detect -- yes --> Transitions{ready and handoff transitions exist?}
  Transitions -- no --> Reject
  Transitions -- yes --> Accept[valid gated step]
```

## Review Submission

```mermaid
sequenceDiagram
  participant Child
  participant Harness
  participant Pi as Pi event bus
  participant Review as Plannotator

  Child->>Harness: result outcome ready plus handoff fields plus artifact
  Harness->>Harness: beginGate and persist awaiting-gate
  Harness->>Pi: plannotator:request action plan-review
  Pi->>Review: review request with opaque artifact
  Review-->>Pi: handled pending reviewId
  Pi-->>Harness: reviewId
  Harness->>Harness: attachGateReviewId and persist
```

## Review Result

```mermaid
flowchart TD
  Event[plannotator:review-result] --> Parse{valid reviewId and approved?}
  Parse -- no --> Ignore[ignore]
  Parse -- yes --> Match{matches pendingGate.reviewId?}
  Match -- no --> Ignore
  Match -- yes --> Paused{run paused?}
  Paused -- yes --> Store[store resolution for resume]
  Paused -- no --> Awaiting{run awaiting-gate?}
  Awaiting -- no --> Ignore
  Awaiting -- yes --> Approved{approved?}
  Approved -- yes --> ApprovedTransition[follow ready transition]
  Approved -- no --> RejectedTransition[follow handoff transition and gate.feedback]
  ApprovedTransition --> Settle[settleAfterTransition]
  RejectedTransition --> Settle
```

## Resume Polling

```mermaid
flowchart TD
  Resume["/workflow-resume"] --> Pending{pending gate has reviewId and no resolution?}
  Pending -- no --> Apply[resume or apply stored resolution]
  Pending -- yes --> Status[emit plannotator review-status]
  Status --> Response{status}
  Response -- pending --> Await[remain awaiting gate]
  Response -- completed --> Store[store resolution]
  Response -- missing --> Fail[failGate with feedback]
  Response -- unavailable --> Error[notify and block resume]
  Response -- error --> Error
  Store --> Apply
  Fail --> Apply
```

If a gate submission is interrupted before a Plannotator review id is recorded,
resume fails that pending submission and asks the current step to submit again.
If a review id was recorded, resume polls Plannotator and either applies the
completed decision, keeps waiting, or blocks when the review cannot be queried.

## Feedback Flow

```mermaid
flowchart LR
  ReviewedArtifact[human-reviewed artifact] --> Approved[approved gate]
  Approved --> ReviewedState[reviewed.artifact template value]
  StepSummary[separate compact step summary] --> Approved
  Approved --> LastSummary[stepHandoff and last.summary]
  ReviewerFeedback[review feedback] --> Rejected[rejected gate]
  Rejected --> GateArtifact[gate.artifact template value]
  Rejected --> GateFeedback[gate.feedback template value]
```

Gate outcome names are fixed: `ready` submits the artifact and is reused after
approval, while rejection follows the step's self-looping `handoff` transition.
The approved artifact remains separate from the compact summary, and neither
value changes permissions or the run's captured working directory.
Plannotator's `approved` boolean is authoritative; annotation labels and
feedback text are never parsed as decisions. On rejection, the harness starts a
fresh same-step attempt with `{{gate.feedback}}` and the opaque rejected draft
in `{{gate.artifact}}`, while preserving the step's original incoming handoff,
then waits at a new review. These explicitly human-mediated transitions bypass
the visit-limit check and can continue until approval. Each visit remains
recorded, so later automatic same-step handoffs are still guarded.
