# Pi Workflows OpenWiki

This is the technical reference for Pi Workflows: its architecture, coding
boundaries, workflow contracts, security model, integrations, and verification
strategy. Use the linked pages for exact implementation decisions and edge
cases.

## Navigation

```mermaid
flowchart TD
  Q[OpenWiki index] --> A[architecture/overview.md]
  Q --> L[architecture/runtime-lifecycle.md]
  Q --> W[authoring/workflow-files.md]
  Q --> S[authoring/settings-and-project-workflows.md]
  Q --> P[security/policy-model.md]
  Q --> G[integrations/subagents.md]
  Q --> R[integrations/plannotator.md]
  Q --> D[development/testing.md]

  A --> P
  L --> G
  W --> S
  W --> R
  D --> A
```

## System At A Glance

```mermaid
flowchart LR
  Human[Human or agent invokes slash command]
  Files[Workflow YAML and prompt files]
  Harness[WorkflowHarness parent]
  State[Persisted WorkflowRun checkpoint]
  Main[Main Pi agent]
  Child[pi-subagents child]
  Policy[Step policy]
  MainComplete[workflow_complete_step]
  ChildComplete[structured_output]
  Gate[Optional prompt or Plannotator gate]

  Files --> Harness
  Human --> Harness
  Harness --> State
  Harness --> Policy
  Policy --> Main
  Policy --> Child
  Main --> MainComplete
  Child --> ChildComplete
  MainComplete --> Harness
  ChildComplete --> Harness
  Harness --> Gate
  Gate --> Harness
  Harness --> State
```

## Repository Map

```mermaid
flowchart TD
  Root[pi-workflows]
  Root --> Src[src]
  Root --> Schemas[schemas]
  Root --> Examples[examples]
  Root --> Tests[test]

  Src --> Index[index.ts<br/>parent or child mode]
  Src --> Domain[domain<br/>shared workflow types]
  Src --> Function[function<br/>validation, transitions, policy, prompts]
  Src --> Infra[infrastructure<br/>Pi, files, runtimes, integrations]
  Src --> UI[ui<br/>status rendering]

  Schemas --> WorkflowSchema[workflow.schema.json]
  Schemas --> SettingsSchema[settings.schema.json]
  Infra --> Agents[agents/profile.ts<br/>workflow role prompts]
  Examples --> Starter[starter-kit<br/>work]
  Starter --> RolePrompts[agents<br/>planner, reviewer, scout, worker, workspace-preparer]
  Tests --> TestSuite[Bun test suite]
```
