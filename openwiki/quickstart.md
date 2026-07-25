# Pi Workflows OpenWiki

Pi Workflows is a declarative, pauseable workflow harness for Pi. Read the system from the diagrams first; use the linked pages for exact fields and edge cases.

## Navigation

```mermaid
flowchart TD
  Q[quickstart.md] --> A[architecture/overview.md]
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
  Root --> Agents[agents]
  Root --> Examples[examples]
  Root --> Tests[test]

  Src --> Index[index.ts<br/>parent or child mode]
  Src --> Harness[harness.ts<br/>commands, checkpoints, orchestration]
  Src --> Config[config<br/>load, validate, ceiling]
  Src --> Engine[engine<br/>pure state transitions]
  Src --> Policy[policy<br/>tool, Bash, MCP enforcement]
  Src --> Integrations[integrations<br/>prompt, subagents, Plannotator]
  Src --> Prompt[prompt.ts<br/>template rendering]
  Src --> Runtime[runtime<br/>main steps, completion, serial queue]

  Schemas --> WorkflowSchema[workflow.schema.json]
  Schemas --> SettingsSchema[settings.schema.json]
  Agents --> StepAgent[step.md<br/>default profile and child guidance]
  Examples --> MR[mr-comments workflow]
  Tests --> TestSuite[Bun test suite]
```

## Install And Run

```mermaid
flowchart TD
  Bun[bun install] --> Check[bun run check]
  Check --> InstallLocal[pi install /absolute/path/to/pi-workflows]
  InstallLocal -. optional .-> InstallSubagents[pi install npm:pi-subagents]
  InstallLocal -. optional .-> InstallPlan[pi install npm:@plannotator/pi-extension]
  InstallLocal --> Reload["/reload"]
  Reload --> WorkflowReload["/workflow-reload"]
  WorkflowReload --> Start["/workflow-start mr-comments input"]
```

Core commands:

| Command                        | Purpose                             |
| ------------------------------ | ----------------------------------- |
| `/workflow-list`               | List loaded workflows.              |
| `/workflow-start <id> [input]` | Start by workflow id.               |
| `/<workflow command> [input]`  | Start through configured alias.     |
| `/workflow-pause [reason]`     | Halt execution and checkpoint.      |
| `/workflow-resume`             | Reload, reconcile, and continue.    |
| `/workflow-abort [reason]`     | Abort active run.                   |
| `/workflow-reload`             | Reload files when no run is active. |

The main surface has no task-viewer pane. Its footer shows only a compact
`◐`/`◓`/`◑`/`◒` indicator while work is running, then clears it. The full
overlay opens at workflow start; toggle it with `Ctrl+Alt+W`, or hide it with
`q` or `Esc`. The overlay contains every step and diagnostic detail, using `✓`
for completed, `✕` for failed or aborted, and `◆` for paused or awaiting
review. It clamps long reasons to its available width while the checkpoint
keeps the complete message. On short terminals, scroll with `↑`/`↓`,
PgUp/PgDn, or Home/End.

Delegated steps require pi-subagents 0.36.0 or newer. Each `subagent.agent`
value selects the actual Pi Subagents profile, and each profile starts with a
fresh context containing only the explicit workflow input and compact handoff.

Configured workflow aliases accept multiline input. For example,
`/work\n"""request"""` is normalized to `/work """request"""` and dispatched as
the workflow command rather than as a normal parent-agent turn.

## Default Workflow Location

```mermaid
flowchart TD
  Env{PI_WORKFLOWS_DIR set?}
  Env -- yes --> Explicit[Use PI_WORKFLOWS_DIR]
  Env -- no --> AgentDir{PI_CODING_AGENT_DIR set?}
  AgentDir -- yes --> AgentWorkflows[Use PI_CODING_AGENT_DIR/workflows]
  AgentDir -- no --> Home[Use ~/.pi/agent/workflows]
  Explicit --> Files[workflow YAML plus optional settings.yaml]
  AgentWorkflows --> Files
  Home --> Files
```
