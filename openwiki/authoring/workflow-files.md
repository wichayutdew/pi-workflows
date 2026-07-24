# Workflow Authoring

## Workflow Shape

```mermaid
flowchart TD
  Workflow[WorkflowDefinition] --> Version[version = 1]
  Workflow --> Identity[id, command, description]
  Workflow --> Start[start step id]
  Workflow --> Limits[maxStepVisits, summaryMaxChars]
  Workflow --> Steps[steps map]

  Steps --> Step[WorkflowStep]
  Step --> Prompt[inline prompt or prompt file]
  Step --> Subagent[subagent options]
  Step --> Permissions[permissions]
  Step --> Requires[requires preflight]
  Step --> Transitions[outcome transitions]
  Step --> Gate[optional Plannotator gate]
```

## Minimal Two-Step Graph

```mermaid
stateDiagram-v2
  [*] --> inspect
  inspect --> implement: ready
  inspect --> paused: blocked
  implement --> completed: done
  implement --> paused: blocked
```

```json
{
  "version": 1,
  "id": "fix",
  "command": "fix",
  "description": "Inspect, implement, and verify a change",
  "start": "inspect",
  "steps": {
    "inspect": {
      "prompt": "Inspect {{workflow.input}} without modifying files.",
      "permissions": {
        "tools": ["read", "grep", "bash"],
        "bash": { "mode": "read-only" }
      },
      "transitions": {
        "ready": "implement",
        "blocked": "$pause"
      }
    },
    "implement": {
      "prompt": { "file": "prompts/implement.md" },
      "permissions": {
        "tools": ["read", "edit", "write", "bash"],
        "bash": {
          "mode": "allow-list",
          "allow": [{ "executable": "npm", "argsPrefix": ["test"] }]
        }
      },
      "transitions": {
        "done": "$done",
        "blocked": "$pause"
      }
    }
  }
}
```

## Prompt Rendering

```mermaid
flowchart LR
  Input[workflow command input] --> Values[template values]
  Run[WorkflowRun] --> Values
  Step[WorkflowStep] --> Values
  Gate[gate feedback] --> Values
  Prompt[inline or file prompt] --> Render[renderTemplate]
  Values --> Render
  Render --> Task[delegated child task]
```

Supported variables:

| Variable | Source |
| --- | --- |
| `{{workflow.input}}` | Command input. |
| `{{workflow.id}}` | Workflow definition. |
| `{{run.id}}` | Runtime run. |
| `{{step.id}}` | Current step. |
| `{{step.title}}` | Current step. |
| `{{last.summary}}` | Previous completed step. |
| `{{gate.feedback}}` | Latest rejected gate. |

## Prompt File Safety

```mermaid
flowchart TD
  FileRef[prompt.file] --> Absolute{absolute path or null byte?}
  Absolute -- yes --> Reject[reject workflow]
  Absolute -- no --> Resolve[resolve relative to workflow file dir]
  Resolve --> Inside{inside workflow dir?}
  Inside -- no --> Reject
  Inside -- yes --> Realpath[resolve symlink realpath]
  Realpath --> RealInside{real path still inside?}
  RealInside -- no --> Reject
  RealInside -- yes --> Read[read prompt text]
  Read --> Vars{only supported variables?}
  Vars -- no --> Reject
  Vars -- yes --> Loaded[loaded prompt]
```

## Permissions Shape

```mermaid
flowchart TD
  Permissions[permissions] --> Tools[tools exact Pi tool names]
  Permissions --> MCP[mcp server or server/tool selectors]
  Permissions --> Extensions[extension source selectors]
  Permissions --> Skills[skills injected into child]
  Permissions --> Bash[bash mode and allow rules]
  Requires[requires] --> ReqTools[required tools]
  Requires --> ReqExt[required extensions]
  Requires --> ReqSkills[required skills]
  ReqTools --> Preflight[preflight before launch]
  ReqExt --> Preflight
  ReqSkills --> Preflight
```

## Subagent Options

```mermaid
flowchart TD
  Subagent[subagent] --> Agent[agent<br/>default pi-workflows.step]
  Subagent --> Context[context<br/>fresh or fork]
  Subagent --> Model[model override]
  Subagent --> Timeout[timeoutMs<br/>1000 to 86400000]
  Subagent --> TurnBudget[turnBudget<br/>maxTurns, graceTurns]
  Subagent --> ToolBudget[toolBudget<br/>soft, hard, block]
  Subagent --> Artifacts[artifacts boolean]
```

## Example MR Comments Workflow

```mermaid
stateDiagram-v2
  [*] --> inspect
  inspect --> plan: ready
  inspect --> paused: blocked
  plan --> implement: approved
  plan --> plan: changes-requested
  plan --> paused: blocked
  implement --> verify: ready
  implement --> paused: blocked
  verify --> completed: passed
  verify --> implement: failed
  verify --> paused: blocked
```

Business intent: inspect merge-request feedback, create a reviewed plan, implement it, then verify the result.

