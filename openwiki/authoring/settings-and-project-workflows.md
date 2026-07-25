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
  Skills --> Bash{Bash mode, rules, and approved sources within ceiling?}
  Bash --> Delegated{subagent configured?}
  Delegated -- no --> Accept[accept project step]
  Delegated -- yes --> SubCeiling{subagent ceiling present?}
  SubCeiling -- no --> Reject[reject project step]
  SubCeiling -- yes --> Profile{agent profile allowed?}
  Profile --> Context{fresh context allowed?}
  Context --> Model{model absent or allowed?}
  Model --> Timeout{timeout <= maxTimeoutMs?}
  Timeout --> Turns{turnBudget present and within ceiling?}
  Turns --> ToolBudget{toolBudget present, hard <= maxToolCalls, block = *?}
  ToolBudget --> Artifacts{artifacts allowed?}
  Artifacts --> Retry{broad automatic recovery allowed?}
  Retry --> Accept
```

If any decision is false, the project workflow is diagnosed and skipped.
Main-only project workflows do not need a `subagent` ceiling. Delegated project
steps require that ceiling plus explicit turn and tool budgets. The ceiling's
`agents` list contains the actual Pi Subagents profiles a project workflow may
launch. Each delegated request still uses a fresh context. After its capability
is verified, the workflow policy is the sole active-tool allow-list inside the
child; the selected profile still determines which extension providers were
loaded and therefore available to activate.

`retryToolFailures` authorizes up to two fresh automatic recovery attempts in
allow-list or unrestricted Bash mode. Denied and read-only Bash do not need the
opt-in. In every mode, each candidate failure still needs a complete trusted
child transcript, the original task and per-request binding, and an audit
proving that every actual call was read-only or rejected before execution under
the same approved exact-command inputs as child execution.

A step may expose `edit` or `write` and still use automatic recovery when those
tools were not called. Their availability alone is not a veto; a recorded
`edit`, `write`, mutation-capable Bash, or unknown-effect call makes that
attempt unsafe. Recovery also stops when a fresh attempt repeats a previous
semantic failure fingerprint. Project workflows may enable broader Bash
recovery only when the user ceiling also sets
`subagent.retryToolFailures: true`.

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
