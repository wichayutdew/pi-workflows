# Policy Model

Main-agent and delegated steps share tool authorization and completion parsing.
The first diagram shows the stronger delegated process boundary; main-agent
mode enforces the same model calls inside the parent process but cannot isolate
the transcript, globally loaded skills, or extension event handlers.

## Trust Boundary

```mermaid
flowchart LR
  Parent[Parent WorkflowHarness<br/>trusted orchestration]
  Policy[ChildStepPolicy<br/>signed by digest plus capability]
  Child[Child subagent<br/>untrusted step work]
  Tools[Pi tools and MCP]
  Result[result.json]

  Parent --> Policy
  Policy --> Child
  Child -->|authorized calls only| Tools
  Child -->|structured_output| Result
  Result -->|validated by parent| Parent
```

## Delegated Parent Acceptance Checks

```mermaid
flowchart TD
  Response[child terminal response] --> Completed{status completed?}
  Completed -- no --> Pause[pause workflow]
  Completed -- yes --> Session{session epoch matches?}
  Session -- no --> Ignore[ignore stale response]
  Session -- yes --> Run{run id matches?}
  Run -- no --> Ignore
  Run -- yes --> Step{step id and digest match?}
  Step -- no --> Ignore
  Step -- yes --> Result[read result.json]
  Result --> Digest{policy digest matches?}
  Digest -- no --> Pause
  Digest -- yes --> Outcome{outcome allowed?}
  Outcome -- no --> Pause
  Outcome -- yes --> Apply[apply transition or gate]
```

## Delegated Child Policy Contents

```mermaid
flowchart TD
  Policy[ChildStepPolicy] --> Identity[workflowId, runId, stepId, stepTitle]
  Policy --> Capability[capabilityPath and token]
  Policy --> ResultPath[resultPath]
  Policy --> Digest[policyDigest]
  Policy --> Perms[permissions]
  Policy --> Outcomes[allowed outcomes]
  Policy --> Limit[summaryMaxChars]
  Policy --> Gate[optional gateSubmitOutcome]
  Policy --> Workspace[optional bind outcomes and allowed roots]
```

## Tool Authorization

```mermaid
flowchart TD
  Call[tool call] --> Completion{active completion tool?}
  Completion -- yes --> Batch{only tool call in message?}
  Batch -- no --> Block[block]
  Batch -- yes --> Complete[validate completion result]

  Completion -- no --> Exact{tool in permissions.tools?}
  Exact -- yes --> Bash{tool is bash?}
  Exact -- no --> MCP{tool is mcp?}
  MCP -- yes --> MCPAuth[authorize explicit server/tool selector]
  MCP -- no --> Extension{source matches allowed extension?}
  Extension -- yes --> Allow[allow]
  Extension -- no --> Block
  Bash -- yes --> BashAuth[authorize Bash command]
  Bash -- no --> Allow
  MCPAuth --> Allow
  BashAuth --> Allow
```

## Bash Authorization

```mermaid
flowchart TD
  BashCall[bash command] --> Mode{mode}
  Mode -- deny --> Block[block]
  Mode -- unrestricted --> Allow[allow]
  Mode -- allow-list --> Parse
  Parse --> SafeSyntax{no shell operators, substitutions, expansions, wrappers?}
  SafeSyntax -- no --> Block
  SafeSyntax -- yes --> Rule{matches executable and normalized argument prefix?}
  Rule -- yes --> Allow
  Rule -- no --> Block
```

Allow-list matching is deliberately domain-neutral. The engine does not
classify package-manager, framework, version-control, or hosted-API commands,
and it does not change argument order. Command syntax comes from the agent's
context; the YAML rule only defines executable scope.

## Completion Contract

```mermaid
flowchart TD
  Complete[completion params] --> Outcome{outcome in policy.outcomes?}
  Outcome -- no --> Reject[throw]
  Outcome -- yes --> Summary{summary trims non-empty and <= limit?}
  Summary -- no --> Reject
  Summary -- yes --> Gate{outcome is gateSubmitOutcome?}
  Gate -- yes --> Artifact{artifact non-empty?}
  Artifact -- no --> Reject
  Artifact -- yes --> Mode{execution mode}
  Gate -- no --> Mode
  Mode -- delegated structured_output --> Write[atomic result.json write]
  Mode -- main --> Capture[capture pending in memory]
  Write --> Terminate[terminate turn]
  Capture --> Terminate
```

For a delegated step, pi-subagents 0.36 creates `structured_output` from the
request's workflow result schema and agent contract v1. For a main-agent step,
the harness registers `workflow_complete_step`. Both paths feed the same
outcome, summary, artifact, sole-call, and policy-digest validation. The
workflow step permissions become the sole active-tool allow-list after the
child capability is verified. The selected subagent profile still controls
which extension providers are loaded; unavailable providers fail closed.

The harness captures the working directory when a run starts. A configured
delegated step may bind one canonical existing directory under a YAML-authorized
root; every reachable downstream step, revisit, recovery attempt, and resume
then reuses it. Without a binding, the run-start directory remains effective.
The candidate is accepted only through structured result data for an exact
configured outcome. Summaries and gate artifacts cannot select a directory,
and the extension does not create or interpret worktrees.

Gate artifacts are persisted separately from compact step summaries and remain
opaque to the engine. A workflow prompt may define any artifact format and use
it through `{{reviewed.artifact}}`; neither its contents nor an outcome label
grant additional permissions.

## Immutable Input Defense

```mermaid
sequenceDiagram
  participant Runtime as main or child runtime
  participant Input as tool input object
  participant Later as later extension handlers
  participant Tool as tool executor

  Runtime->>Input: authorize
  Runtime->>Input: recursively freeze
  Later->>Input: attempted mutation
  Input-->>Later: mutation rejected or ignored
  Tool->>Input: executes authorized arguments
```
