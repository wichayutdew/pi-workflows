# Architecture Overview

## Module Topology

```mermaid
flowchart TD
  Pi[Pi extension host] --> Entry[src/index.ts]

  Entry -->|parent mode| HarnessFacade[src/harness.ts<br/>WorkflowHarness facade]
  Entry -->|child mode| ChildRuntime[src/infrastructure/runtime/child-runtime.ts]

  HarnessFacade --> HarnessActions[src/infrastructure/harness/*<br/>action modules]
  HarnessFacade --> Commands[src/infrastructure/harness/commands.ts]
  HarnessActions --> ConfigLoader[src/infrastructure/fs/load.ts<br/>Node loader]
  HarnessActions --> EngineCore[src/function/engine/*<br/>pure transitions]
  HarnessActions --> PromptCore[src/function/prompt/*<br/>prompt rendering]
  HarnessActions --> SubClient[src/infrastructure/process/subagent-client.ts]
  HarnessActions --> Plannotator[src/infrastructure/integrations/plannotator*.ts]
  HarnessActions --> PromptGate[src/infrastructure/integrations/prompt-gate.ts]
  HarnessActions --> MainRuntime[src/infrastructure/runtime/main-step-runtime.ts]
  HarnessActions --> Queue[src/infrastructure/runtime/task-queue.ts]
  HarnessActions --> StatusCore[src/ui/*]

  ConfigLoader --> ConfigCore[src/function/config/*]
  ConfigCore --> Domain[src/domain/*<br/>shared types]
  ConfigCore --> Digest[src/function/digest.ts]

  MainRuntime --> PolicyCore[src/function/policy/*]
  ChildRuntime --> PolicyCore
  ChildRuntime --> ChildPolicy[src/function/subagent/child-policy-*]
  ChildRuntime --> ChildFiles[src/infrastructure/fs/subagent-files.ts]
  SubClient --> SubDiagnostics[src/function/subagent/diagnostics.ts]
  StatusCore --> Transcript[src/infrastructure/fs/transcript-reader.ts]
```

`src/index.ts` is the only Pi extension entry point. It chooses parent mode by
constructing `WorkflowHarness`, or child mode by registering the delegated
subagent runtime when `PI_WORKFLOWS_CHILD=1`,
`PI_WORKFLOWS_CHILD_RUNTIME=1`, and `PI_WORKFLOWS_CHILD_AGENT` is set.

## Source Tree Guide

The current source tree is split by dependency direction: shared domain types,
pure functional cores, infrastructure adapters that touch Pi/files/processes,
and UI rendering.

For file-level ownership, use
[Orchestration Modules](./orchestration-modules.md) for configuration, state,
and parent coordination, and
[Execution Modules](./execution-modules.md) for integrations, policy, prompts,
runtimes, and status rendering.

| Area                                   | Handles                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`                          | Canonical shared types and constants for configuration, runs, policies, harness state, Plannotator, status rendering, step results, subagents, and role profiles.                                                               |
| `src/function/`                        | Pure application logic: configuration validation, digests, workflow doctor checks, immutable engine transitions, policy decisions, preflight checks, prompt rendering, step-result parsing, and child-policy validation.          |
| `src/infrastructure/fs/`               | Node-backed filesystem adapters for settings/workflow loading, YAML parsing, catalog assembly, child result workspaces, and transcript reads.                                                                                   |
| `src/infrastructure/harness/`          | Parent-mode orchestration. `harness.ts` composes action modules for start, restart, pause, resume, lifecycle, status, gate, prompt-review, Plannotator, main-step, and delegation flows.                                        |
| `src/infrastructure/integrations/`     | External review adapters for Plannotator, prompt gates, and the optional Herdr companion reporter.                                                                                                                              |
| `src/infrastructure/process/`          | Pi Subagents parent-side process/event client.                                                                                                                                                                                   |
| `src/infrastructure/runtime/`          | Main-agent and child-agent runtimes, completion tools, policy hooks, lifecycle handling, trace capture, same-child repair, tool-budget handoff mode, and task serialization.                                                    |
| `src/ui/`                              | Workflow status text, board/detail rendering, usage formatting, step logs, layout helpers, shortcut labels, and the interactive TUI view.                                                                                       |
| `src/harness.ts`                       | Root compatibility export for `WorkflowHarness` from `src/infrastructure/harness/harness.ts`.                                                                                                                                   |
| `src/herdr-workflow-state.ts`          | Optional Herdr companion reporter that mirrors workflow lifecycle state to Herdr's managed pane status socket.                                                                                                                   |
| `src/index.ts`                         | Pi extension factory with injected environment, settings loader, child-runtime registration, and harness creation boundaries.                                                                                                    |

## Parent And Child Modes

```mermaid
flowchart TD
  Start[src/index.ts loaded by Pi]
  Start --> ChildEnv{PI_WORKFLOWS_CHILD=1<br/>and runtime enabled?}
  ChildEnv -- no --> Parent[Create WorkflowHarness]
  ChildEnv -- yes --> NameOk{child agent<br/>env set?}
  NameOk -- yes --> Child[Register child runtime]
  NameOk -- no --> Noop[Return without registering workflow runtime]

  Parent --> ParentWork[Commands, catalog, checkpoints, main execution or delegation]
  Child --> ChildWork[Policy extraction, workflow-tool activation, structured completion validation]
```

## Data Model

```mermaid
flowchart LR
  WorkflowFile[workflow YAML] --> Definition[WorkflowDefinition]
  PromptFiles[prompt markdown] --> Loaded[LoadedWorkflow]
  Definition --> Loaded
  Loaded --> WorkflowDigest[workflow digest]
  Loaded --> StepDigests[step and structural digests]

  Loaded --> Run[WorkflowRun]
  Run --> History[StepHistoryEntry list]
  Run --> Gate[PendingGate optional]
  Run --> Handoff[stepHandoff and lastSummary]
  Run --> Reviewed[reviewedArtifact provenance]
  Run --> Workspace[run-start and bound cwd]
  Run --> Trace[bounded step attempts and logs]
  Run --> Baseline[baselineTools]
  Run --> Checkpoint[pi-workflows-state-v1 session entry]
```

## Responsibility Split

```mermaid
flowchart TD
  Config[Config functional core] -->|normalized definitions and diagnostics| Harness
  Engine[Engine functional core] -->|pure immutable run transitions| Harness
  Prompting[Prompt functional core] -->|rendered step task| Harness
  Policy[Policy functional core] -->|authorization decisions| MainRuntime
  Policy -->|authorization decisions| ChildRuntime
  Status[Status rendering core] -->|overlay text and TUI view| Harness

  Harness -->|main step policy and task| MainRuntime
  Harness -->|delegation request and policy envelope| Subagents
  Subagents -->|child process input| ChildRuntime
  MainRuntime -->|validated result| Harness
  ChildRuntime -->|validated correlated result file| Subagents
  Subagents -->|terminal response| Harness
```

The functional cores are deliberately small and injectable. Configuration
loading binds filesystem and environment ports in `createConfigLoader`, the
harness binds Pi, timers, temporary workspaces, Plannotator, prompt gates,
subagents, status views, and main-step runtime through
`createWorkflowHarnessDependencies`, and the main-step and child runtimes take
policy/parsing/file dependencies. Tests can replace those ports without
changing workflow state logic.

Layer barrels keep internal imports explicit: `src/domain/index.ts` exports
shared types, `src/function/index.ts` exports pure logic, `src/infrastructure/index.ts`
exports adapters and runtimes, and `src/ui/index.ts` exports status rendering.

## Catalog Loading

```mermaid
flowchart TD
  Settings[Load settings.yaml] --> UserDir[Load user workflow YAML]
  UserDir --> AddUser[Add user workflows]
  AddUser --> ProjectEnabled{allowProjectWorkflows?}
  ProjectEnabled -- no --> RuntimeConflicts[Check runtime command conflicts]
  ProjectEnabled -- yes --> Trusted{Project trusted?}
  Trusted -- no --> Warning[Warn and skip project workflows]
  Trusted -- yes --> CeilingSet{permissionCeiling configured?}
  CeilingSet -- no --> Error[Error and skip project workflows]
  CeilingSet -- yes --> ProjectDir[Load project workflow YAML]
  ProjectDir --> CeilingCheck[Apply permission ceiling]
  CeilingCheck --> AddProject[Add nonconflicting project workflows]
  AddProject --> RuntimeConflicts
  Warning --> RuntimeConflicts
  Error --> RuntimeConflicts
  RuntimeConflicts --> Catalog[WorkflowCatalog with diagnostics]
```
