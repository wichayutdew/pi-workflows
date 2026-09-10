# Settings And Workflow Directories

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

Only this user-owned directory is loaded. Project-local `.pi/workflows`, project trust settings, and permission ceilings are not supported.

## Status Shortcut

The workflow status overlay uses `Ctrl+Alt+W` by default. Configure another Pi key identifier in the user-owned settings file:

```yaml
version: 1
statusShortcut: ctrl+shift+y
```

Run `/workflow-status` to open the overlay. Run Pi's `/reload` after changing `statusShortcut` so the extension can re-register the key.

## Duplicate And Command Conflict Rules

Duplicate workflow IDs, duplicate workflow commands, and commands that conflict with Pi are diagnosed and not registered.

## Diagnostics

Invalid workflow or settings YAML, unknown fields, unsafe prompt paths, duplicate IDs or commands, and runtime command conflicts produce `ConfigDiagnostic` entries in `/workflow-reload` output.
