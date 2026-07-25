# Subagent Integration

This integration is optional. A step runs in the main Pi agent when
`subagent` is omitted; `subagent: {}` opts into the delegated runtime below.
`subagent: worker` assigns the step's `worker` specialty while retaining the
workflow defaults. The object form accepts the same specialty under `agent`
when the step also needs execution overrides.

Pi Subagents supplies the foreground-child transport. Pi Workflows always asks
it to launch the bundled `pi-workflows.step` runtime, then supplies the
specialty identity and step-specific prompt inside the correlated task.

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
  Sub-->>Bus: prompt-template:subagent:response
  Bus-->>Harness: finish delegation
```

## Delegation Request Payload

```mermaid
flowchart TD
  Request[SubagentDelegationRequest] --> Version[version 1]
  Request --> Id[requestId]
  Request --> Agent[fixed runtime pi-workflows.step]
  Request --> Task[rendered task with specialty plus policy envelope]
  Request --> Context[fresh]
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
  Verify --> Baseline[capture bundled runtime active tools]
  Baseline --> Complete[lazily register workflow_complete_step]
  Complete --> Narrow[intersect runtime tools with step permissions]
  Narrow --> Prompt[append child system prompt]
  Prompt --> Work[child performs step]
```

## Runtime And Specialty Resolution

Pi Workflows passes `pi-workflows.step` through the public delegation API for
every workflow child. Pi Subagents resolves that packaged runtime and applies
settings for that actual name. The workflow's configured `agent` value is
instead recorded in the policy digest and rendered into the child task as
`Step specialty`; it is also used in workflow status. A value such as
`subagent: scout` therefore does not select Pi Subagents' builtin `scout`
profile.

The fixed runtime is a compatibility boundary. General-purpose Pi Subagents
profiles can declare explicit tool allow-lists; those lists can hide extension
tools registered after startup, including `workflow_complete_step`. The
bundled runtime leaves the workflow child runtime free to register that
correlated completion tool and then narrow normal tools to the step policy.

The workflow request deliberately owns fresh context, timeout, skills,
artifacts, and its optional model override. The configured specialty identifies
the role, the step prompt supplies its exact instructions, and the previous
step's self-contained compact summary or approved gate artifact supplies the
only cross-step handoff. Parent and sibling transcripts are never inherited.
The request's skill selection replaces the bundled runtime's normal skills for
that step. Pi Subagents' separate acceptance report is disabled because
`workflow_complete_step` and workflow gates are the authoritative completion
contract.

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

## Planning And Questions

Delegated workflow children are non-interactive. The child runtime removes and
blocks `contact_supervisor`, `subagent_supervisor`, and `intercom`, preventing a
dependency-level detach from escaping the workflow lifecycle.

Planning steps put unresolved decisions in their plan artifact. Plannotator or
the user resolves them before approval; the approved artifact becomes the
implementation handoff. After approval, implementation and verification never
ask terminal questions. If the approved plan is insufficient or stale, the
step returns a pause outcome with evidence instead of opening a side channel.

The installed workflow set uses planning as its only human-decision gate.
Plan approval may authorize an exact remote-action contract. Later handoffs may
remove actions but cannot grant new ones: the harness intersects commands from
the reviewed plan with commands retained by the latest completed-step handoff
before enabling Bash.

## Agent And Policy Boundary

```mermaid
flowchart TD
  Settings[Pi Subagents settings for pi-workflows.step] --> Runtime[resolved active tools]
  Workflow[workflow step permissions] --> Intersection[tool intersection]
  Runtime --> Intersection
  Capability[single-use workflow capability] --> Completion[workflow_complete_step]
  Intersection --> Effective[effective child tools]
  Completion --> Effective
```

The bundled runtime's resolved tools are an outer visibility boundary. Pi
Workflows may narrow them but cannot activate a normal tool or extension that
Pi Subagents excluded. The completion tool is the sole addition and appears
only after capability verification.
