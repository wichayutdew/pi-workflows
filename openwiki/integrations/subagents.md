# Subagent Integration

This integration is optional. A step runs in the main Pi agent when
`subagent` is omitted; `subagent: {}` opts into the delegated runtime below.
`subagent: pi-workflows.inspector` selects a named workflow agent while
retaining the defaults. The object form accepts the same name under `agent`
when the step also needs execution overrides.

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
  Request --> Agent[agent pi-workflows.*]
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
  PiChild[Pi child process] --> Env{PI_SUBAGENT_CHILD=1 and agent pi-workflows.*?}
  Env -- no --> Stop[do not register child runtime]
  Env -- yes --> Runtime[registerSubagentChildRuntime]
  Runtime --> SessionStart[session_start]
  SessionStart --> NoTools[setActiveTools empty]
  NoTools --> Input[input event]
  Input --> Extract[extract policy envelope]
  Extract --> Verify[verify child agent and capability]
  Verify --> Narrow[resolveActiveTools]
  Narrow --> Prompt[append child system prompt]
  Prompt --> Work[child performs step]
```

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

## Bundled Agent Boundary

```mermaid
flowchart TD
  StepMD[agents/step.md] --> Name[name step]
  StepMD --> Package[package pi-workflows]
  Package --> RuntimeName[pi-workflows.step]
  StepMD --> InheritProject[inherits project context]
  StepMD --> NoSkills[does not inherit parent skills]
  StepMD --> Fresh[default fresh context]
  RuntimeName --> Policy[child runtime policy enforcement]
```
