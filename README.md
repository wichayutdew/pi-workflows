# Pi Workflows

A declarative, pauseable workflow harness for Pi.

## Overview

Pi Workflows keeps orchestration code generic and moves workflow behavior into small configuration and prompt files. Each workflow defines its own steps, transitions, subagent profile and budgets, tool access, MCP access, Bash policy, extensions, skills, dependency checks, and optional human-review gate.

The harness owns state transitions. Every step runs in a separate [pi-subagents](https://github.com/nicobailon/pi-subagents) child process instead of consuming the main agent context. The child can advance only by calling `workflow_complete_step` with an outcome declared by that step.

## Install

Install both Pi packages. `pi-subagents` must be installed separately so Pi
loads its extension:

```bash
pi install npm:pi-subagents
```

Pi Workflows targets pi-subagents `0.35.1` or newer. Run
`/subagents-doctor` if a step cannot start.

For local development:

```bash
pi install /absolute/path/to/pi-workflows
```

Pi loads `src/index.ts` through the package manifest. Restart Pi or run `/reload` after changing extension source.

## Add a workflow

User workflows live in:

```text
~/.pi/agent/workflows/*.workflow.json
```

Set `PI_WORKFLOWS_DIR` to use another directory. The example can be copied as a starting point:

```bash
mkdir -p ~/.pi/agent/workflows/prompts
cp examples/mr-comments.workflow.json ~/.pi/agent/workflows/
cp -R examples/prompts/mr-comments ~/.pi/agent/workflows/prompts/
```

The example `$schema` path is repository-relative. Adjust or remove it after copying.

Run `/workflow-reload`, then start by configured command:

```text
/mr-comments <merge-request URL or description>
```

Every workflow is also available through:

```text
/workflow-start mr-comments <merge-request URL or description>
```

## Minimal workflow

```json
{
  "$schema": "./schemas/workflow.schema.json",
  "version": 1,
  "id": "fix",
  "command": "fix",
  "description": "Inspect, implement, and verify a change",
  "start": "inspect",
  "steps": {
    "inspect": {
      "prompt": "Inspect {{workflow.input}} without modifying files.",
      "subagent": {
        "agent": "pi-workflows.step",
        "context": "fresh",
        "timeoutMs": 600000
      },
      "permissions": {
        "tools": ["read", "grep", "bash"],
        "bash": { "mode": "read-only" }
      },
      "requires": {
        "tools": ["read", "bash"]
      },
      "transitions": {
        "ready": "implement",
        "blocked": "$pause"
      }
    },
    "implement": {
      "prompt": { "file": "prompts/implement.md" },
      "subagent": {
        "agent": "pi-workflows.step",
        "context": "fresh",
        "timeoutMs": 1200000
      },
      "permissions": {
        "tools": ["read", "edit", "write", "bash"],
        "bash": {
          "mode": "allow-list",
          "allow": [
            { "executable": "npm", "argsPrefix": ["test"] }
          ]
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

The loader rejects unknown properties, duplicate identifiers, missing targets,
unsafe prompt paths, invalid gate contracts, Pi command-name conflicts, and
project permissions above the user ceiling. Conflicts with commands from other
loaded extensions or prompt resources are diagnosed before aliases register.

## Configuration

Top-level fields:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | Yes | — | Configuration contract version. Currently `1`. |
| `id` | Yes | — | Stable workflow identifier. |
| `command` | Yes | — | Slash command without `/`. |
| `description` | Yes | — | Command description. |
| `start` | Yes | — | First step identifier. |
| `steps` | Yes | — | Step map. Order is controlled by transitions, not JSON order. |
| `maxStepVisits` | No | `5` | Loop guard for each step. |
| `summaryMaxChars` | No | `4000` | Maximum persisted step handoff length. |

Each step supports:

| Field | Required | Description |
| --- | --- | --- |
| `title` | No | Human-readable name. Defaults to the step identifier. |
| `prompt` | Yes | Inline text or `{ "file": "relative/path.md" }`. |
| `subagent` | No | Child agent, context mode, model, timeout, budgets, and artifact capture. |
| `permissions` | No | Resources callable during this step. Everything defaults to denied. |
| `requires` | No | Dependencies that must be detectable before the step starts. |
| `transitions` | Yes | Exact outcome to next step, `$pause`, or `$done`. |
| `gate` | No | A supported external human-review gate. |

Supported prompt variables:

```text
{{workflow.input}}
{{workflow.id}}
{{run.id}}
{{step.id}}
{{step.title}}
{{last.summary}}
{{gate.feedback}}
```

Unknown variables fail configuration loading.

### Per-step subagents

Every step is delegated automatically through the public
`pi-subagents/delegation` v1 API. No main-agent turn performs the step.
`subagent` is optional because these safe defaults are applied:

```json
{
  "subagent": {
    "agent": "pi-workflows.step",
    "context": "fresh",
    "timeoutMs": 900000,
    "artifacts": false
  }
}
```

The bundled `pi-workflows.step` profile inherits project instructions but not
the parent transcript or its skill catalog. The workflow explicitly sends only
the configured step prompt and skills. Pi Workflows then narrows the child's
active tools and enforces the step's MCP, Bash, extension-tool, and completion
policy inside the child process.

Supported fields:

| Field | Default | Description |
| --- | --- | --- |
| `agent` | `pi-workflows.step` | Configured workflow-only pi-subagents agent in the `pi-workflows.*` namespace. |
| `context` | `fresh` | `fresh` isolates the step; `fork` deliberately includes filtered parent context. |
| `model` | Agent/default model | Optional pi-subagents model override. |
| `timeoutMs` | `900000` | Child deadline, from 1 second through 24 hours. |
| `turnBudget` | pi-subagents default | `{ "maxTurns": n, "graceTurns": n }`. |
| `toolBudget` | pi-subagents default | `{ "soft": n, "hard": n, "block": "*" }`; `block` may instead be a tool-name array. |
| `artifacts` | `false` | Ask pi-subagents to retain its normal run artifacts. |

You may define another workflow-only agent by using `package: pi-workflows` in
its frontmatter, which gives it a runtime name such as
`pi-workflows.inspector`. This namespace lets the extension leave every
unrelated pi-subagents child untouched. A custom profile's own `tools` and
`extensions` frontmatter remains an outer visibility boundary: Pi Workflows can
remove access but cannot grant a tool or load an extension that the profile
excluded.

Use the bundled profile unless you intentionally maintain a stricter one. If a
custom profile declares `tools`, it must include `workflow_complete_step`; if it
declares `extensions`, it must keep the installed Pi Workflows extension
available. Otherwise the child fails closed because it cannot verify and write
the correlated result.

At runtime:

1. The harness creates a correlated child policy and result channel.
2. pi-subagents starts one foreground child for the current step.
3. The child runtime enforces permissions and writes the validated result.
4. The parent harness applies the configured transition, then delegates the next step.

### Per-step permissions

`tools` contains exact Pi tool names available to the child.

`mcp` contains `server` or `server/tool` selectors for the generic `mcp` proxy:

```json
{
  "mcp": [
    "gitlab/get_merge_request",
    "gitlab/list_merge_request_discussions"
  ]
}
```

The harness requires an explicit `server` and `tool` on every proxy call. Proxy search, discovery, connection, and authentication modes are blocked while a workflow step is running.

The generic `mcp` proxy is the portable choice for delegated steps. A custom
subagent profile may expose direct MCP tools through its own `mcp:` frontmatter;
Pi Workflows still requires each direct runtime name in `tools`.

`extensions` contains case-insensitive fragments matched against tool source metadata. Tools registered by matching extensions become visible and callable:

```json
{
  "extensions": ["plannotator"]
}
```

The MCP adapter is excluded from this broad extension rule. Grant proxy access through `mcp`, and grant a direct MCP tool only by its exact name in `tools`.

`skills` states which skills pi-subagents injects into the child. Put mandatory resources under `requires`:

```json
{
  "permissions": {
    "skills": ["superpowers:test-driven-development"],
    "extensions": ["plannotator"]
  },
  "requires": {
    "skills": ["superpowers:test-driven-development"],
    "extensions": ["plannotator"]
  }
}
```

The harness preflights required resources in the parent, passes the selected
skills to pi-subagents, restricts child tools, and authorizes every child model
tool call. Loaded extension event handlers still execute inside the child
process; the tool policy does not unload extension code.

### Bash modes

| Mode | Behavior |
| --- | --- |
| `deny` | Blocks Bash. This is the default. |
| `read-only` | Allows a small built-in inspection preset. Shell composition and expansion are rejected. |
| `allow-list` | Allows one executable plus configured argument prefixes. |
| `unrestricted` | Allows any Bash command. Use only in user-owned workflows. |

Restricted modes reject shell operators, substitutions, expansions, wrapper shells, environment assignments, and known execution options in the read-only preset.

An allow-list rule is a token prefix, not a string prefix:

```json
{
  "mode": "allow-list",
  "allow": [
    { "executable": "git", "argsPrefix": ["status"] },
    { "executable": "npm", "argsPrefix": ["test"] }
  ]
}
```

This permits `npm test -- --runInBand` but not `npm run build`.

Hard turn and tool-call budgets are best for read-only inspection and
verification steps. For a step that edits files, use a generous timeout and no
hard count budget unless partial edits are acceptable; inspect the working tree
after any interruption before resuming.

## Works great with Plannotator

[Plannotator](https://github.com/backnotprop/plannotator) gives Pi a local,
browser-based surface for visually reviewing and annotating plans. Install its
Pi extension alongside Pi Workflows:

```bash
pi install npm:@plannotator/pi-extension
```

Pi Workflows uses Plannotator's shared extension API as a human approval gate:

- A workflow submits its plan or other Markdown artifact.
- Plannotator opens the visual review in your browser.
- Approval advances through the configured transition.
- Requested changes return structured feedback to the configured revision step.
- Pausing never discards a decision; resume queries the same review identifier.

This keeps workflow order and permissions declarative while Plannotator handles
the human review experience.

### Configure a Plannotator gate

A step can submit an artifact to the installed Plannotator extension:

```json
{
  "permissions": {
    "extensions": ["plannotator"]
  },
  "requires": {
    "extensions": ["plannotator"]
  },
  "gate": {
    "provider": "plannotator",
    "submitOutcome": "submit",
    "approvedOutcome": "approved",
    "rejectedOutcome": "changes-requested",
    "timeoutMs": 5000
  },
  "transitions": {
    "approved": "implement",
    "changes-requested": "plan",
    "blocked": "$pause"
  }
}
```

The delegated child calls `workflow_complete_step` with outcome `submit` and the full content in `artifact`. The child runtime writes an attested result, then the parent harness correlates the Plannotator review identifier and accepts only the matching decision.

If review finishes while the workflow is paused, the result is checkpointed and applied only after `/workflow-resume`. Resume also queries Plannotator’s durable review status, so a decision made while Pi was closed is not lost.

## Pause, repair, resume

Use:

```text
/workflow-pause <optional reason>
```

The harness sends the versioned pi-subagents cancellation event and waits for
the correlated terminal response before restoring the main session’s baseline
tools. It keeps the exact current step and persists the checkpoint in the Pi
session. A late child response cannot advance a paused, aborted, reconfigured,
or replaced run.

If termination is not confirmed within five seconds, the pause is recorded but
main tools remain isolated and resume is blocked. Wait for the terminal event;
if the delegation channel has already failed, restart Pi before resuming. This
prevents an old writer and a resumed writer from overlapping.

While paused, fix repository code, workflow JSON, prompts, MCP configuration, an extension, or any other environmental problem. Then run:

```text
/workflow-resume
```

Resume reloads configuration before continuing:

- The paused step starts a new subagent child.
- A changed current step restarts that step.
- A changed completed step restarts the earliest changed completed step.
- Future-only changes preserve the current checkpoint.
- Removing the current or a completed step fails closed and requires restoring configuration or aborting.
- Restoring a Pi session automatically pauses an in-progress workflow for inspection.
- An interrupted gate without a recorded review identifier restarts the current step for resubmission.

## Commands

| Command | Purpose |
| --- | --- |
| `/workflow-list` | List loaded workflows and their configured commands. |
| `/workflow-start <id> [input]` | Start by workflow identifier. |
| `/<configured-command> [input]` | Start through a workflow alias. |
| `/workflow-status` | Show run, state, current step, and review identifier. |
| `/workflow-pause [reason]` | Halt without losing the checkpoint. |
| `/workflow-resume` | Reload, reconcile, and continue. |
| `/workflow-abort [reason]` | End the active run and restore baseline tools. |
| `/workflow-reload` | Reload definitions while no workflow is running. |

## User and project configuration

User workflows are loaded first. A project may add workflows from:

```text
<project>/.pi/workflows/*.workflow.json
```

Project workflows are disabled by default. Enable them in the user-owned `~/.pi/agent/workflows/settings.json`:

```json
{
  "version": 1,
  "allowProjectWorkflows": true,
  "permissionCeiling": {
    "tools": ["read", "grep", "bash"],
    "mcp": [],
    "extensions": [],
    "skills": [],
    "bash": { "mode": "read-only" },
    "subagent": {
      "agents": ["pi-workflows.step"],
      "contexts": ["fresh"],
      "models": [],
      "maxTimeoutMs": 900000,
      "maxTurns": 40,
      "maxGraceTurns": 3,
      "maxToolCalls": 100,
      "artifacts": false
    }
  }
}
```

Project workflows load only when Pi trusts the project and every step stays
within this ceiling. Each project step must declare `turnBudget` and
`toolBudget` with `"block": "*"`, so it cannot silently inherit unbounded child
defaults or keep mutation tools after reaching the hard limit. The
ceiling also controls child agent names, context inheritance, model overrides,
timeouts, and artifact retention. Project workflows cannot override user
workflow identifiers or commands.

## Architecture

The package keeps the Pi entry point intentionally small:

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Pi entry point only. |
| `src/harness.ts` | Runtime orchestration and session lifecycle. |
| `src/commands.ts` | User command surface. |
| `src/config/` | Types, strict validation, prompt loading, precedence, ceilings. |
| `src/engine/` | Serializable run state and deterministic transitions. |
| `src/policy/` | Tool, MCP, and Bash enforcement. |
| `src/integrations/subagents/` | Delegation client, child protocol, and child policy runtime. |
| `src/integrations/plannotator.ts` | Versioned Plannotator gate adapter. |
| `src/preflight.ts` | Required tool, extension, and skill checks. |
| `src/prompt.ts` | Template rendering and step contract. |
| `agents/step.md` | Bundled dynamic-policy pi-subagents profile. |

The engine and policy modules do not depend on Pi runtime types, so they are fast to test.

## Security model

Pi extensions are not an operating-system sandbox. Installed extensions execute with the user’s process permissions.

The harness provides process separation plus model-level least privilege:

- one separate pi-subagents child process per workflow step;
- an idle, tool-isolated main agent while a step runs;
- child active-tool narrowing;
- a single-use, parent-created child capability tied to the selected workflow agent;
- authoritative child `tool_call` blocking;
- immutable tool arguments after authorization;
- child completion as the sole call in its tool batch;
- explicit MCP server and tool checks;
- restricted Bash parsing;
- project trust and a user-owned permission ceiling;
- fail-closed durable state, correlated child results, and correlated gate results.

It does not restrict commands the human explicitly runs with Pi’s `!` Bash
input. It also cannot disable side effects performed autonomously by an
extension loaded in the child, and it is not an operating-system sandbox.
Review workflow, agent, and extension source before installing or enabling it.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests cover graph validation, prompt confinement, command conflicts, project
ceilings, deterministic transitions, configuration reconciliation, pause/resume
state, gate handling, MCP isolation, Bash policy, extension tool selection,
subagent request correlation and cancellation, child policy enforcement, and
dependency preflight.

## Publishing checklist

Before publishing:

1. Confirm the npm package name and repository metadata.
2. Run `npm run check`.
3. Publish to npm.

The `pi-package` keyword makes the package discoverable by the Pi package gallery.

## Good next parameters

The current schema covers the execution harness requested here. Useful future
extensions, without hard-coding them into the orchestrator, are:

| Parameter | Why it belongs in configuration |
| --- | --- |
| Retry and backoff | Let a step distinguish a transient child failure from a workflow-level pause. |
| Acceptance criteria | Give each step machine-checkable completion evidence and verification commands. |
| Working directory or worktree | Isolate mutating steps, monorepo packages, and concurrent branches. |
| Parallel groups and join policy | Run independent steps together and declare fail-fast, quorum, or all-success behavior. |
| Generic gates | Add ticket, CI, chat, or custom approval providers behind the same versioned gate contract. |
| Output schema and named artifacts | Pass structured data between steps instead of relying only on a summary. |
| Cost and token ceilings | Bound model spend independently from turn and tool-call budgets. |
| Environment and secret references | Select named credentials without embedding secret values in workflow JSON. |
| Logging and retention | Configure progress events, redaction, child artifact retention, and checkpoint history. |

## Current limits

- Each workflow step delegates to one foreground subagent. Parallel or chained children inside one step are not yet a workflow-level primitive.
- Plannotator plan review is the only built-in external gate.
- A custom subagent profile can be narrower than a step, but Pi Workflows cannot widen that profile.
- Child extension tools are enforced; autonomous extension event-handler side effects cannot be disabled per step.
- Workflow configuration uses JSON. Prompt bodies may live in separate Markdown files.

## License

Licensed under the [Apache License 2.0](./LICENSE).
