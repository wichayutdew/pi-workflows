# Plannotator Integration

Plannotator is optional. A gate with no `provider` uses Pi's built-in prompt
panel; `provider: plannotator` opts into this integration.

Any gated step may submit an artifact. A delegated child returns it through
`structured_output`; a main-agent step uses `workflow_complete_step`. The step
prompt—not Pi Workflows—defines the artifact's format, purpose, acceptance
criteria, and downstream use. The integration transports that content without
parsing it or turning it into execution authority.

## Gate State Machine

```mermaid
stateDiagram-v2
  running --> awaiting_gate: step outcome = submitOutcome
  awaiting_gate --> running: rejectedOutcome
  awaiting_gate --> running: approvedOutcome to next step
  awaiting_gate --> completed: approvedOutcome to $done
  awaiting_gate --> paused: manual pause
  paused --> running: resume applies stored rejection
  paused --> running: resume applies stored approval to next step
  paused --> completed: resume applies stored approval to $done
```

## Gate Validation

```mermaid
flowchart TD
  Gate[gate config] --> Provider{provider}
  Provider -- omitted or prompt --> Prompt[use built-in Pi review]
  Provider -- plannotator --> Detect{extension detectable?}
  Provider -- other --> Reject[reject workflow]
  Detect -- no --> Preflight[block step preflight]
  Detect -- yes --> Outcomes{approved != rejected?}
  Prompt --> Outcomes
  Outcomes -- no --> Reject
  Outcomes -- yes --> Transitions{approved and rejected transitions exist?}
  Transitions -- no --> Reject
  Transitions -- yes --> Submit{submitOutcome absent from transitions?}
  Submit -- no --> Reject
  Submit -- yes --> Accept[valid gated step]
```

## Review Submission

```mermaid
sequenceDiagram
  participant Child
  participant Harness
  participant Pi as Pi event bus
  participant Review as Plannotator

  Child->>Harness: result outcome submit plus summary plus artifact
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
  Approved -- yes --> ApprovedTransition[use approvedOutcome]
  Approved -- no --> RejectedTransition[use rejectedOutcome and gate.feedback]
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

A built-in review opened from print or JSON mode remains paused because those
modes cannot show the dialog. Reopen the same session in TUI or RPC mode and
run `/workflow-resume`; the harness presents the preserved pending artifact
instead of rerunning the step.

## Feedback Flow

```mermaid
flowchart LR
  ReviewedArtifact[human-reviewed artifact] --> Approved[approved gate]
  Approved --> ReviewedState[reviewed.artifact template value]
  StepSummary[separate compact step summary] --> Approved
  Approved --> LastSummary[stepHandoff and last.summary]
  ReviewerFeedback[review feedback] --> Rejected[rejected gate]
  Rejected --> GateFeedback[gate.feedback template value]
```

Approval and rejection outcome names are opaque transition labels. The
extension does not infer planning, retry, replan, or implementation semantics
from them. The approved artifact remains separate from the compact summary, and
neither value changes permissions or the run's captured working directory.
