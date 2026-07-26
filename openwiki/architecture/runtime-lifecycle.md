# Runtime Lifecycle

## Run State Machine

```mermaid
stateDiagram-v2
  [*] --> running: createRun
  running --> running: step outcome to next step
  running --> awaiting_gate: gate submitOutcome
  awaiting_gate --> running: rejected or approved to another step
  awaiting_gate --> completed: approved to $done
  running --> completed: outcome to $done
  running --> paused: outcome to $pause
  running --> paused: manual pause or failure
  awaiting_gate --> paused: manual pause
  paused --> running: resume runnable step
  paused --> awaiting_gate: resume pending review
  paused --> completed: resume stored approved gate to $done
  running --> aborted: abort
  paused --> aborted: abort
  awaiting_gate --> aborted: abort
  completed --> [*]
  aborted --> [*]
```

The state machine is implemented by the pure engine modules under
`src/engine/`. `create-run.ts` creates the initial immutable run,
`run-advance.ts` handles ordinary step outcomes, `gate-transitions.ts` handles
review submission and resolution, `run-lifecycle.ts` owns pause/resume/abort
helpers, and `run-reconciliation.ts` plus `reconciliation-history.ts` reconcile
persisted checkpoints after workflow files change. `transitions.ts` and
`state.ts` are compatibility facades over those modules.

## Start Sequence

```mermaid
sequenceDiagram
  participant User
  participant Harness as WorkflowHarness
  participant Config as loadCatalog
  participant Engine as createRun
  participant Pi as Pi tools/status
  participant Main as MainStepRuntime
  participant Sub as pi-subagents

  User->>Harness: /workflow-start id input
  Harness->>Pi: abort active main turn if needed
  Harness->>Config: reload workflows
  Config-->>Harness: WorkflowCatalog
  Harness->>Harness: preflight start step
  Harness->>Pi: capture baseline tools
  Harness->>Engine: createRun
  Harness->>Pi: append checkpoint
  Harness->>Pi: setActiveTools([])
  alt subagent omitted
    Harness->>Main: activate policy and send user message
  else subagent configured
    Harness->>Sub: configured profile delegation request
  end
```

Parent-mode orchestration starts in `src/harness.ts`, but the behavior is now
split across action modules in `src/harness/`. `start-actions.ts` reloads the
catalog, checks the requested step, captures baseline tools, creates the run,
persists the checkpoint, and launches either a main step or a delegated step.
`dependencies.ts` is the injected boundary for Pi APIs, time, IDs,
configuration loading, temporary delegation workspaces, status display,
Plannotator, prompt gates, subagents, and the main-step runtime.

## Main-Agent Step Sequence

```mermaid
sequenceDiagram
  participant Harness
  participant Runtime as MainStepRuntime
  participant Pi
  participant Engine

  Harness->>Runtime: activate step policy
  Runtime->>Pi: narrow active tools
  Harness->>Pi: send rendered step task
  Pi->>Runtime: workflow_complete_step
  Runtime->>Runtime: validate correlated result
  Pi-->>Runtime: agent_settled
  Runtime-->>Harness: validated result
  Harness->>Engine: advanceRun or beginGate
```

Main-agent execution is registered by `src/runtime/main-step-runtime.ts`. That
facade creates a controller over `main-step-state.ts`,
`main-step-lifecycle.ts`, `main-step-policy.ts`, and
`main-step-completion.ts`; it also preserves the older `MainStepRuntime` class
for compatibility. Policy decisions come from `src/policy/tools.ts`,
`bash.ts`, `completion-batch.ts`, and `immutable-input.ts`, while completion
payloads are parsed by `step-result.ts`.

## Delegated Step Sequence

```mermaid
sequenceDiagram
  participant Harness
  participant Tmp as temp result dir
  participant Sub as pi-subagents
  participant Child as child runtime
  participant Engine

  Harness->>Tmp: write capability token
  Harness->>Harness: build ChildStepPolicy and digest
  Harness->>Sub: request configured profile with handoff and encoded policy
  Sub->>Child: start selected profile in a fresh context
  Child->>Tmp: verify and delete capability
  Child->>Child: narrow active tools
  Child->>Tmp: validate structured_output and write result.json
  Sub-->>Harness: completed response
  Harness->>Tmp: read result.json
  Harness->>Engine: advanceRun or beginGate
  Harness->>Tmp: cleanup
```

The workflow `subagent.agent` value selects the actual Pi Subagents profile.
Each v1 request uses `output: false`, the workflow `outputSchema`, and agent
contract v1. It starts in a clean context with the original workflow input and
the previous step's compact result. An approved artifact is available only when
the prompt explicitly renders `{{reviewed.artifact}}`; no accumulated parent or
sibling transcript crosses the step boundary.

Delegation planning and recovery decisions live in `src/harness/delegation-*.ts`
and launch through `step-execution-actions.ts`. The parent-side subagent client
surface remains `src/integrations/subagents/client.ts`; the correlated request,
event handling, cancellation, late terminal handling, and timeout work is split
across `client-delegation.ts`, `client-messages.ts`, and `client-types.ts`.

The child side is registered by `child-runtime.ts`. Its implementation modules
parse the encoded policy envelope, validate child agent identity and private
capability/result paths, narrow active tools, block interactive coordination
tools, authorize Bash/MCP/tool calls through the shared policy core, validate
structured completion, and write the bounded result file. Diagnostic modules
under the same folder read replay audits, hidden Bash failures, and session
transcripts so the harness can decide whether automatic recovery is safe.

### Failure Recovery Before Pause

A terminal error or nonzero exit code is evidence, not an unconditional stop.
The harness first considers two bounded recovery paths:

1. If the trusted child transcript proves that `structured_output` completed
   after the reported failure, the harness validates the terminal identity and
   projection, reads the private correlated result, and requires the transcript
   value and result file to match exactly. This also covers the narrowly
   reproduced hidden Bash false-positive case.
2. Otherwise, the harness may launch up to two fresh automatic recovery
   attempts. Candidate statuses are `failed`, `structured_output_failed`,
   `timed_out`, `turn_budget_exhausted`, and `tool_budget_exhausted`. Every
   failed attempt needs a complete, correctly bound transcript whose actual
   calls prove that no mutation can be repeated.

Configured `edit` or `write` availability is not by itself a veto. An actual
recorded `edit`, `write`, executed Bash, or other unknown-effect call makes the
audit unsafe. Denied Bash needs no opt-in; `retryToolFailures` authorizes the
same bounded sequence for allow-list or unrestricted Bash, but never bypasses
the actual-call audit.

Each recovery launches a fresh child with all previous bounded failure evidence.
Failures receive a stable semantic fingerprint that excludes request IDs and
session paths. If a fresh child repeats any previous fingerprint, recovery stops
early instead of repeating the same approach.

Cancellation, interruption, detached/stopped execution, inconsistent timeout
projections, reported file mutation, protocol/setup failure, and unbound,
incomplete, or malformed audit evidence are hard stops. A synchronous
delegation startup exception is caught and routed through serialized failure
handling instead of escaping the harness.

`delegation-failure.ts` gathers evidence,
`delegation-recovery-validation.ts` proves recovered completion consistency,
`delegation-retry-policy.ts` makes the replay decision, and
`delegation-response-actions.ts` plus `delegation-control-actions.ts` continue
or retry the run. The workflow pauses only when recovery is ambiguous, unsafe,
or exhausted. This reduces user intervention without automatically repeating a
possibly successful external mutation.

Temporary delegation workspace removal is best-effort housekeeping. Cleanup
failures produce a bounded warning, but cannot interrupt an otherwise healthy
transition, successful recovery, or newly launched attempt.

## Live Status

```mermaid
flowchart LR
  Run[Workflow checkpoint] --> Board[shortcut-toggleable detail overlay]
  Active[active delegation or main step] --> Board
  Active --> Footer[animated workflow and current-step indicator]
```

The footer cycles through `◐`, `◓`, `◑`, and `◒` and identifies the workflow
and current step only while work runs; it is cleared when execution stops. It
never renders a below-editor task board. Completed steps, failures, pauses,
reviews, attempt logs, and full history live in the overlay; its rendering
clamps long reasons to the available terminal width without altering the full
persisted reason. Arrow keys or `j`/`k` select a path entry; `Enter`, right, or
`l` opens its persisted attempt evidence. Detail scroll uses arrows or `j`/`k`,
while left, `h`, or `Esc` returns. Attempt tasks, results, and gate decisions
are globally bounded in the checkpoint. Confined child transcript references
are read on demand through stable no-follow reads; displayed controls and
common credentials are removed. New main-agent attempts arm trace capture only
when Pi finalizes the exact workflow task, then persist
a redacted, size-bounded prefix of finalized assistant and tool events in
source order. These events remain part of the parent session, but the explorer
does not read unrelated parent-session traffic; legacy attempts without a log
still display their bounded task and result.

After a transition is durably checkpointed, the harness posts one visible
`workflow-step-summary` message without triggering another model turn.
Successful steps and step-requested pauses relay only the schema-validated
summary; the final message also marks the workflow complete. Other pauses relay
their bounded reason. Failures relay a short redacted reason while their full
diagnostic and attempt history remain confined to the checkpoint and explorer.

The status facade is `src/workflow-status.ts`. Rendering and display details
are split into `workflow-status/format-status.ts`, `formatting.ts`,
`layout.ts`, `render-board.ts`, `render-path.ts`, `render-step-detail.ts`,
`render-summary.ts`, `transcript-reader.ts`, `types.ts`, and `view.ts`; harness
status actions call that facade instead of formatting the overlay inline.

## Pause And Resume

```mermaid
flowchart TD
  Pause["/workflow-pause"] --> Active{active execution?}
  Active -- main --> Stop[deactivate and abort turn]
  Active -- prompt gate --> Dismiss[dismiss review panel]
  Active -- child --> Cancel[emit cancellation]
  Active -- none --> Checkpoint[write paused checkpoint]
  Stop --> Restore[restore baseline tools]
  Dismiss --> Restore
  Cancel --> Confirmed{terminal response received?}
  Confirmed -- yes --> Restore[restore baseline tools]
  Confirmed -- no --> Isolate[keep main tools isolated]
  Restore --> Checkpoint
  Isolate --> BlockResume[resume blocked until child terminal]
  Checkpoint --> Resume["/workflow-resume"]
  Resume --> Reload[reload catalog]
  Reload --> Doctor[reject reachable completion traps]
  Doctor --> Reconcile[reconcile digests]
  Reconcile --> Preflight[preflight current step]
  Preflight --> Launch[launch configured main or delegated step]
```

A step-requested `$pause` preserves the incoming `stepHandoff` and records the
failed attempt separately in `lastSummary`; the resumed prompt renders both.
The persisted `reviewedArtifact` stays opaque and cannot grant Bash authority.

External effects are not exactly once. If a publish step stops after a remote
action succeeds but before it checkpoints, resume uses the same declarative step
permissions. The step prompt must inspect observable remote state, skip only
proven-complete actions, and pause on ambiguity.

Pause and resume are coordinated by `pause-actions.ts`, `resume-action.ts`,
`delegation-control-actions.ts`, `prompt-gate-actions.ts`, and
`plannotator-result-actions.ts`. Engine helpers only produce the next
checkpoint state; harness actions own effect cleanup, active-tool restoration,
child cancellation, prompt review dismissal, and relaunching the current step.

## Session Restore

```mermaid
flowchart TD
  Session[session_start or session_tree] --> Epoch[increment session epoch]
  Epoch --> Cancel[cancel active execution]
  Cancel --> Reload[reload catalog]
  Reload --> Latest[read latest pi-workflows-state-v1 entry]
  Latest --> Valid{checkpoint valid?}
  Valid -- no --> Stop[notify invalid checkpoint and stop recovery]
  Valid -- yes --> Running{status running or awaiting-gate?}
  Running -- yes --> Pause[convert to paused for inspection]
  Running -- no --> Restore[restore checkpoint as-is]
  Pause --> Persist[append new checkpoint]
  Restore --> Tools[restore baseline tools unless delegated child unconfirmed]
  Persist --> Tools
```

## Reconciliation On Resume

```mermaid
flowchart TD
  Resume[Paused run plus loaded workflow] --> Exists{workflow exists?}
  Exists -- no --> Error[block resume]
  Exists -- yes --> Current{current step exists?}
  Current -- no --> Error
  Current -- yes --> ApprovedChanged{approved gate digest changed?}
  ApprovedChanged -- yes --> Preserve[refresh digest and preserve reviewed artifact]
  ApprovedChanged -- no --> CompletedChanged{ordinary completed step changed?}
  Preserve --> CompletedChanged
  CompletedChanged -- yes --> Restart[restart at earliest changed ordinary step]
  CompletedChanged -- no --> CurrentChanged{current step digest changed?}
  CurrentChanged -- yes --> Pause[stay paused for inspection]
  CurrentChanged -- no --> Continue[resume current step or gate]
  Restart --> Pause
```

A completed human-approved gate is reconciled from its separately persisted
reviewed artifact, so editing or reloading that gated step's prompt does not ask
the step to run again. This exception applies only while the gate still exists,
its approved outcome matches the recorded outcome, and the recorded history
retains the same artifact. Legacy checkpoints fall back to their historical
summary representation. Other completed-step drift still rewinds to the
earliest changed step.
