# Subagent Integration

This integration is optional. A step runs in the main Pi agent when
`subagent` is omitted; `subagent: {}` opts into the delegated runtime below.
`subagent: worker` selects the Pi Subagents `worker` runtime while retaining
the workflow defaults. The object form accepts the same name under `agent`
when the step also needs execution overrides. Pi Subagents owns discovery and
applies matching `subagents.agentOverrides` from Pi settings.

## Event Protocol

```mermaid
sequenceDiagram
  participant Harness as WorkflowHarness
  participant Bus as Pi event bus
  participant Sub as pi-subagents
  participant Child as pi-workflows child

  Harness->>Bus: prompt-template:subagent:request
  Bus->>Sub: delegation request v1
  Sub-->>Bus: prompt-template:subagent:started
  Bus-->>Harness: started
  Sub->>Child: launch child process
  Child-->>Sub: progress and terminal status
  Sub-->>Bus: prompt-template:subagent:update
  Bus-->>Harness: update status
  Child-->>Sub: contact_supervisor
  Sub-->>Bus: supervisor request v1
  Bus-->>Harness: checkpoint paused request
  Harness-->>Bus: supervisor reply v1 (TUI)
  Bus-->>Sub: reply to same child
  Sub-->>Bus: prompt-template:subagent:response
  Bus-->>Harness: finish delegation
```

## Delegation Request Payload

```mermaid
flowchart TD
  Request[SubagentDelegationRequest] --> Version[version 1]
  Request --> Id[requestId]
  Request --> Agent[discovered agent runtime name]
  Request --> Task[rendered task plus policy envelope]
  Request --> Context[fresh or fork]
  Request --> Cwd[cwd]
  Request --> Timeout[timeoutMs]
  Request --> Skills[skill list or false]
  Request --> Artifacts[artifacts boolean]
  Request --> Optional[optional model, turnBudget, toolBudget]
```

## Child Startup

```mermaid
flowchart TD
  PiChild[Pi child process] --> Env{PI_SUBAGENT_CHILD=1 and valid runtime name?}
  Env -- no --> Stop[do not register child runtime]
  Env -- yes --> Runtime[register inert policy listeners]
  Runtime --> Input[input event]
  Input --> Envelope{workflow policy envelope?}
  Envelope -- no --> Ordinary[leave ordinary child untouched]
  Envelope -- yes --> Verify[verify exact child agent and capability]
  Verify --> Baseline[capture resolved profile active tools]
  Baseline --> Complete[lazily register workflow_complete_step]
  Complete --> Narrow[intersect profile tools with step permissions]
  Narrow --> Prompt[append child system prompt]
  Prompt --> Work[child performs step]
```

## Agent Resolution

Pi Workflows passes the configured `agent` unchanged through the public
delegation API. Pi Subagents resolves that name across its builtin, package,
user, and project agents, then applies `settings.json` precedence and disabled
state. Pi Workflows deliberately does not read or mirror that settings schema.

An `agentOverrides.worker` entry customizes the discovered builtin `worker`; it
does not create a new runtime named `worker`. Packaged agents may use qualified
names such as the bundled `pi-workflows.step`.

The workflow request deliberately owns context, timeout, skills, artifacts, and
its optional model override. Its skill selection replaces the agent profile's
normal skills for that step. Pi Subagents' separate acceptance report is
disabled because `workflow_complete_step` and workflow gates are the
authoritative completion contract.

## Result Path

```mermaid
flowchart LR
  Parent[Parent] --> Tmp[mkdtemp tmp/pi-workflows-step-*]
  Tmp --> Cap[capability]
  Tmp --> Result[result.json]
  Parent --> Policy[policy contains both paths]
  Policy --> Child[child]
  Child --> CapCheck[read token with timingSafeEqual]
  CapCheck --> Delete[delete capability]
  Child --> ResultWrite[write result.json once]
  ResultWrite --> ParentRead[parent reads after completed response]
```

## Cancellation And Timeout

```mermaid
stateDiagram-v2
  [*] --> active: delegate request
  active --> active: started or update
  active --> settled: terminal response
  active --> locally_rejected: start timeout, overall timeout, or abort signal
  locally_rejected --> cancelling: emit cancel
  cancelling --> settled: terminal response
  cancelling --> blocked: no terminal response yet
  blocked --> settled: late terminal response
```

While blocked, the harness keeps main tools isolated and refuses resume because a child may still be alive.

## Supervisor Coordination

Delegated steps support child `contact_supervisor` requests with
pi-subagents `0.36.0` or newer. A correlated request pauses the workflow and
persists the child agent, child run, request id, reason, message, and optional
interview payload. The original delegation remains active: Pi Workflows never
starts a replacement child while the request is pending.

In Pi TUI, the workflow opens a reply input. A non-empty reply is sent through
the delegation supervisor-reply event, returns the workflow to running, and
waits for that original child’s terminal response. Dismissing the input keeps
the checkpoint paused; `/workflow-resume` reopens it in TUI. RPC and non-TUI
sessions intentionally keep the workflow paused and must be reopened in TUI
to answer the child. Normal pause, abort, session change, and shutdown still
cancel the child and wait for its terminal result before releasing isolation.

## Agent And Policy Boundary

```mermaid
flowchart TD
  Settings[Pi Subagents settings and profile] --> Profile[resolved active tools]
  Workflow[workflow step permissions] --> Intersection[tool intersection]
  Profile --> Intersection
  Capability[single-use workflow capability] --> Completion[workflow_complete_step]
  Intersection --> Effective[effective child tools]
  Completion --> Effective
```

The selected profile is an outer visibility boundary. Pi Workflows may narrow
it but cannot activate a normal tool or extension that Pi Subagents excluded.
The completion tool is the sole addition and appears only after capability
verification. A custom profile that restricts extension loading must still
load Pi Workflows for delegated workflow steps.
