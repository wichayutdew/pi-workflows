# Settings And Project Workflows

## Directory Resolution

```mermaid
flowchart TD
  Start[loadCatalog] --> Explicit{PI_WORKFLOWS_DIR set?}
  Explicit -- yes --> UserDir[use PI_WORKFLOWS_DIR]
  Explicit -- no --> AgentEnv{PI_CODING_AGENT_DIR set?}
  AgentEnv -- yes --> AgentDir[use PI_CODING_AGENT_DIR/workflows]
  AgentEnv -- no --> HomeDir[use ~/.pi/agent/workflows]

  UserDir --> Settings[settings.yaml]
  AgentDir --> Settings
  HomeDir --> Settings
  Settings --> UserFiles[user workflow YAML]
```

## Status Shortcut

The workflow status overlay uses `Ctrl+Alt+W` by default. Configure another Pi
key identifier in the user-owned settings file:

```yaml
version: 1
statusShortcut: ctrl+shift+y
```

Run `/workflow-status` to open the same overlay without using the shortcut.

Run Pi's `/reload` after changing `statusShortcut` so the extension can
re-register the key. `/workflow-reload` reloads workflow definitions and warns
about a shortcut mismatch, but the active editor keeps the startup binding.

## Project Workflow Gate

```mermaid
flowchart TD
  Settings[settings.yaml] --> Enabled{allowProjectWorkflows?}
  Enabled -- no --> UserOnly[user workflows only]
  Enabled -- yes --> Trusted{ctx.isProjectTrusted?}
  Trusted -- no --> SkipWarn[skip project workflows with warning]
  Trusted -- yes --> Ceiling{permissionCeiling present?}
  Ceiling -- no --> SkipError[skip project workflows with error]
  Ceiling -- yes --> ProjectFiles[load .pi/workflows workflow YAML]
  ProjectFiles --> CeilingCheck[checkWorkflowAgainstCeiling]
  CeilingCheck --> Accepted[add accepted project workflows]
  CeilingCheck --> Rejected[diagnose rejected workflows]
```

## Permission Ceiling

```mermaid
flowchart TD
  Step[Project workflow step] --> Tools{tools within ceiling?}
  Tools --> MCP{MCP selectors within ceiling?}
  MCP --> Extensions{extensions within ceiling?}
  Extensions --> Skills{skills within ceiling?}
  Skills --> Bash{Bash mode and rules within ceiling?}
  Bash --> Workspace{workspace binding absent?}
  Workspace -- yes --> Accept[accept project step]
  Workspace -- no --> Reject[reject project step]
```

If any decision is false, the project workflow is diagnosed and skipped.
The runtime settings validator accepts only tool, MCP, extension, skill, and
Bash ceilings. Project workflow steps may name an `agent` role profile, but
there is no project-level agent ceiling field.

Project workflows cannot declare `workspace` binding. Workflows that create,
choose, or bind a different execution directory must live in the user-owned
workflow directory instead of `.pi/workflows`.

## Duplicate And Command Conflict Rules

```mermaid
flowchart TD
  User[user workflows] --> Catalog[workflow catalog]
  Project[project workflows] --> ExistingId{id already loaded?}
  ExistingId -- yes --> RejectId[reject override]
  ExistingId -- no --> ExistingCommand{command already loaded?}
  ExistingCommand -- yes --> RejectCommand[reject duplicate command]
  ExistingCommand -- no --> Catalog
  Catalog --> Runtime{runtime command conflict?}
  Runtime -- yes --> Drop[drop workflow and diagnose]
  Runtime -- no --> Register[register workflow alias]
```

## Diagnostics

```mermaid
flowchart LR
  BadConfig[invalid workflow or settings YAML] --> Diag[ConfigDiagnostic]
  BadSchema[unknown or invalid fields] --> Diag
  BadPrompt[prompt escape or unknown variable] --> Diag
  Duplicate[duplicate id or command] --> Diag
  Ceiling[ceiling violation] --> Diag
  Conflict[loaded Pi command conflict] --> Diag
  Diag --> Reload["/workflow-reload summary"]
```
