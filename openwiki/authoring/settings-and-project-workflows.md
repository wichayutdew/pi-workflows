# Settings And Project Workflows

## Directory Resolution

```mermaid
flowchart TD
  Start[loadCatalog] --> Explicit{PI_WORKFLOWS_DIR set?}
  Explicit -- yes --> UserDir[use PI_WORKFLOWS_DIR]
  Explicit -- no --> AgentEnv{PI_CODING_AGENT_DIR set?}
  AgentEnv -- yes --> AgentDir[use PI_CODING_AGENT_DIR/workflows]
  AgentEnv -- no --> HomeDir[use ~/.pi/agent/workflows]

  UserDir --> Settings[settings.json]
  AgentDir --> Settings
  HomeDir --> Settings
  Settings --> UserFiles[user *.workflow.json]
```

## Project Workflow Gate

```mermaid
flowchart TD
  Settings[settings.json] --> Enabled{allowProjectWorkflows?}
  Enabled -- no --> UserOnly[user workflows only]
  Enabled -- yes --> Trusted{ctx.isProjectTrusted?}
  Trusted -- no --> SkipWarn[skip project workflows with warning]
  Trusted -- yes --> Ceiling{permissionCeiling present?}
  Ceiling -- no --> SkipError[skip project workflows with error]
  Ceiling -- yes --> ProjectFiles[load .pi/workflows/*.workflow.json]
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
  Skills --> Bash{Bash mode/rules within ceiling?}
  Bash --> Agent{agent allowed?}
  Agent --> Context{context allowed?}
  Context --> Model{model absent or allowed?}
  Model --> Timeout{timeout <= maxTimeoutMs?}
  Timeout --> Turns{turnBudget present and within ceiling?}
  Turns --> ToolBudget{toolBudget present, hard <= maxToolCalls, block = *?}
  ToolBudget --> Artifacts{artifacts allowed?}
  Artifacts --> Accept[accept project step]
```

If any decision is false, the project workflow is diagnosed and skipped.

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
  BadJson[invalid JSON] --> Diag[ConfigDiagnostic]
  BadSchema[unknown or invalid fields] --> Diag
  BadPrompt[prompt escape or unknown variable] --> Diag
  Duplicate[duplicate id or command] --> Diag
  Ceiling[ceiling violation] --> Diag
  Conflict[loaded Pi command conflict] --> Diag
  Diag --> Reload["/workflow-reload summary"]
```
