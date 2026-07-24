[![codecov](https://codecov.io/gh/wichayutdew/pi-workflows/graph/badge.svg?token=33xrCBRM82)](https://codecov.io/gh/wichayutdew/pi-workflows)

# Pi Workflows

A declarative, pauseable workflow harness for Pi.

## Overview

Pi Workflows keeps orchestration code generic and moves workflow behavior into
small YAML configuration and prompt files. Each workflow defines its
own steps, transitions, execution mode, tool access, MCP access, Bash policy,
extensions, skills, dependency checks, and optional human-review gate.

The harness owns state transitions. A step runs in the main Pi agent by default,
or in a separate [pi-subagents](https://github.com/nicobailon/pi-subagents)
child when it declares `subagent`. Either execution mode can advance only by
calling `workflow_complete_step` with an outcome declared by that step.

## Install

Install Pi Workflows from npm:

```bash
pi install npm:@wichayutdew/pi-workflows
```

For local development, install it from the repository instead:

```bash
pi install /absolute/path/to/pi-workflows
```

For the strongest context isolation and browser-based review experience, use it
with both [pi-subagents](https://github.com/nicobailon/pi-subagents) and
[Plannotator](https://github.com/backnotprop/plannotator):

```bash
pi install npm:pi-subagents
pi install npm:@plannotator/pi-extension
```

Neither integration is required, but both are highly recommended together for
the best isolation and review experience. Pi Workflows targets
pi-subagents `0.35.1` or newer. Run `/subagents-doctor` if an explicitly
delegated step cannot start.

Pi loads `src/index.ts` through the package manifest. Restart Pi or run `/reload` after changing extension source.

## Add a workflow

User workflows live in one of these formats:

```text
~/.pi/agent/workflows/*.workflow.yaml
~/.pi/agent/workflows/*.workflow.yml
```

YAML keeps nested steps and permission lists compact. The loader uses the
strict YAML 1.2 core schema: duplicate keys, merge keys, invalid tags,
multiple documents, non-1.2 directives, and excessive alias expansion fail
closed.

Set `PI_WORKFLOWS_DIR` to use another directory. The example can be copied as a starting point:

```bash
mkdir -p ~/.pi/agent/workflows/prompts
cp examples/mr-comments.workflow.yaml ~/.pi/agent/workflows/
cp -R examples/prompts/mr-comments ~/.pi/agent/workflows/prompts/
```

The example YAML language-server schema path is repository-relative. Adjust or
remove its first comment after copying.

Run `/workflow-reload`, then start by configured command:

```text
/mr-comments <merge-request URL or description>
```

Every workflow is also available through:

```text
/workflow-start mr-comments <merge-request URL or description>
```

## Minimal workflow

```yaml
# yaml-language-server: $schema=./schemas/workflow.schema.json
version: 1
id: fix
command: fix
description: Inspect, implement, and verify a change
start: inspect
steps:
  inspect:
    prompt: Inspect {{workflow.input}} without modifying files.
    permissions:
      tools: [read, grep, bash]
      bash:
        mode: read-only
    requires:
      tools: [read, bash]
    transitions:
      ready: implement
      blocked: $pause

  implement:
    prompt:
      file: prompts/implement.md
    permissions:
      tools: [read, edit, write, bash]
      bash:
        mode: allow-list
        allow:
          - executable: bun
            argsPrefix: [test]
    transitions:
      done: $done
      blocked: $pause
```

The loader rejects unknown properties, duplicate identifiers, missing targets,
unsafe prompt paths, invalid gate contracts, Pi command-name conflicts, and
project permissions above the user ceiling. Conflicts with commands from other
loaded extensions or prompt resources are diagnosed before aliases register.

## Configuration

Top-level fields:

| Field             | Required | Default | Description                                                                                        |
| ----------------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| `version`         | Yes      | —       | Configuration contract version. Currently `1`.                                                     |
| `id`              | Yes      | —       | Stable workflow identifier.                                                                        |
| `command`         | Yes      | —       | Slash command without `/`.                                                                         |
| `description`     | Yes      | —       | Command description.                                                                               |
| `start`           | Yes      | —       | First step identifier.                                                                             |
| `steps`           | Yes      | —       | Step map. Order is controlled by transitions, not file order.                                      |
| `maxStepVisits`   | No       | `5`     | Loop guard for each step.                                                                          |
| `summaryMaxChars` | No       | `4000`  | Maximum step `summary` length. Reviewed gate artifacts use their separate 200,000-character limit. |

Each step supports:

| Field         | Required | Description                                                             |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `title`       | No       | Human-readable name. Defaults to the step identifier.                   |
| `prompt`      | Yes      | Inline text or `{ "file": "relative/path.md" }`.                        |
| `subagent`    | No       | Opt into pi-subagents delegation and configure its profile and budgets. |
| `permissions` | No       | Resources callable during this step. Everything defaults to denied.     |
| `requires`    | No       | Dependencies that must be detectable before the step starts.            |
| `transitions` | Yes      | Exact outcome to next step, `$pause`, or `$done`.                       |
| `gate`        | No       | Built-in prompt or Plannotator human-review gate.                       |

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

`{{last.summary}}` normally contains the previous completed step's handoff.
After a step-requested `$pause`, it contains both the preserved incoming
approved/previous-step handoff and the latest paused-attempt summary.

### Per-step subagents

Omit `subagent` to execute the step entirely in the main Pi agent. This is the
portable default and requires no other extension:

```yaml
steps:
  inspect:
    prompt: Inspect the request.
    permissions:
      tools: [read]
    transitions:
      done: $done
```

Add `subagent: {}` to delegate through the public
`pi-subagents/delegation` v1 API with safe defaults:

```yaml
steps:
  inspect:
    subagent: {}
    prompt: Inspect the request.
    transitions:
      done: $done
```

The expanded defaults are `agent: pi-workflows.step`, `context: fresh`,
`timeoutMs: 900000`, and `artifacts: false`.

Use a Pi Subagents runtime name directly when only the agent changes:

```yaml
steps:
  inspect:
    subagent: scout
    prompt: Inspect the request.
    transitions:
      done: $done
```

This name-only form inherits the same defaults. Use the object form when the
step also needs a context, model, timeout, budget, or artifact override:

```yaml
subagent:
  agent: reviewer
  context: fresh
  timeoutMs: 600000
```

`agent` is the same runtime name Pi Subagents uses. For example,
`subagent: worker` selects its builtin `worker`, then Pi Subagents applies the
matching `subagents.agentOverrides.worker` entry from
`~/.pi/agent/settings.json` and any higher-precedence project settings. Pi
Workflows does not parse that file or reimplement agent discovery. An
`agentOverrides` entry modifies a discovered builtin, package, user, or project
agent; the entry alone does not create a new agent.

This is separate from `~/.pi/agent/workflows/settings.yaml`, which configures
Pi Workflows project trust and permission ceilings. Use
`/subagents-models worker` to inspect Pi Subagents' live resolved profile and
`/subagents-doctor` to diagnose discovery or loading problems.

The bundled `pi-workflows.step` remains the default for `subagent: {}`. It
inherits project instructions but not the parent transcript or its skill
catalog. A named agent contributes its Pi Subagents system prompt, thinking,
model unless the step overrides it, extension loading, and initial tool
visibility. The workflow sends its configured step prompt and explicit skill
selection.

Supported fields:

| Field        | Default              | Description                                                                         |
| ------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `agent`      | `pi-workflows.step`  | Any discovered Pi Subagents runtime name, such as `scout`, `worker`, or `reviewer`. |
| `context`    | `fresh`              | `fresh` isolates the step; `fork` deliberately includes filtered parent context.    |
| `model`      | Agent/default model  | Optional pi-subagents model override.                                               |
| `timeoutMs`  | `900000`             | Child deadline, from 1 second through 24 hours.                                     |
| `turnBudget` | pi-subagents default | `{ "maxTurns": n, "graceTurns": n }`.                                               |
| `toolBudget` | pi-subagents default | `{ "soft": n, "hard": n, "block": "*" }`; `block` may instead be a tool-name array. |
| `artifacts`  | `false`              | Ask pi-subagents to retain its normal run artifacts.                                |

Builtin names are unqualified (`worker`); packaged names may be qualified, such
as `pi-workflows.step`. Pi Workflows installs an inert listener in every
Pi Subagents child. It registers `workflow_complete_step` and activates policy
only after a valid, single-use workflow capability arrives, so ordinary
subagent runs remain unchanged.

A selected profile's active tools and loaded extensions remain an outer
boundary. Effective step tools are the intersection of that profile and
`permissions`, plus the workflow completion tool. Pi Workflows can remove
access but cannot grant a normal tool or load an extension excluded by the
profile. If a custom profile declares `extensions`, it must keep the installed
Pi Workflows extension available; otherwise the child never receives the
policy runtime and the step fails closed.

Workflow `permissions.skills` is sent as Pi Subagents' request-level skill
selection, so it replaces the selected profile's normal skill list for that
step; an empty list disables injected skills. Pi Workflows also disables Pi
Subagents' separate acceptance report for these requests because the harness
already owns correlated completion, declared outcomes, and optional human
review gates.

At runtime:

1. The harness creates a correlated child policy and result channel.
2. pi-subagents starts one foreground child for the current step.
3. The child runtime enforces permissions and writes the validated result.
4. The parent harness applies the configured transition, then launches the next step.

Main-agent mode uses the same per-step tool, MCP, Bash, extension-tool, and
completion enforcement, but it cannot unload globally visible skills or
extension event handlers from the parent process. Use pi-subagents when fresh
context, skill isolation, process separation, model selection, or turn/tool
budgets matter.

### Per-step permissions

`tools` contains exact Pi tool names available to the active step.

`mcp` contains `server` or `server/tool` selectors for the generic `mcp` proxy:

```yaml
mcp:
  - gitlab/get_merge_request
  - gitlab/list_merge_request_discussions
```

The harness requires an explicit `server` and `tool` on every proxy call. Proxy search, discovery, connection, and authentication modes are blocked while a workflow step is running.

The generic `mcp` proxy is the portable choice for workflow steps. A custom
subagent profile may expose direct MCP tools through its own `mcp:` frontmatter;
Pi Workflows still requires each direct runtime name in `tools`.

`extensions` contains case-insensitive fragments matched against tool source metadata. Tools registered by matching extensions become visible and callable:

```yaml
extensions: [some-extension]
```

The MCP adapter is excluded from this broad extension rule. Grant proxy access through `mcp`, and grant a direct MCP tool only by its exact name in `tools`.

For delegated steps, `skills` states which skills pi-subagents injects into the
child. In main-agent mode it documents and preflights the intended skills, but
Pi cannot hide other globally loaded skill text. Put mandatory resources under
`requires`:

```yaml
permissions:
  skills: [superpowers:test-driven-development]
  extensions: [plannotator]
requires:
  skills: [superpowers:test-driven-development]
  extensions: [plannotator]
```

The harness preflights required resources, passes selected skills to
pi-subagents when delegation is enabled, restricts active tools, and authorizes
every model tool call. Loaded extension event handlers still execute in their
process; the tool policy does not unload extension code.

### Bash modes

| Mode           | Behavior                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------- |
| `deny`         | Blocks Bash. This is the default.                                                        |
| `read-only`    | Allows a small built-in inspection preset. Shell composition and expansion are rejected. |
| `allow-list`   | Allows one executable plus configured argument prefixes.                                 |
| `unrestricted` | Allows any Bash command. Use only in user-owned workflows.                               |

Restricted modes reject shell operators, substitutions, expansions, wrapper shells, environment assignments, and known execution options in the read-only preset.

Allow-list entries are OR alternatives. `argsPrefix` is one ordered token
sequence:

```yaml
mode: allow-list
allow:
  - executable: git
    argsPrefix: [status]
  - executable: bun
    argsPrefix: [test]
```

This permits `bun test --runInBand` but not `bun run build`.

Use `argsPrefixes` to merge several alternatives for one executable without
widening permission:

```yaml
mode: allow-list
allow:
  - executable: git
    argsPrefixes: [[status], [diff], [show, --stat]]
  - executable: gh
    argsPrefixes: [[pr, view], [pr, diff], [api]]
```

The inner arrays are OR alternatives. Tokens inside one inner array are an
ordered prefix. Therefore `argsPrefix: [status, diff]` means the literal
sequence `git status diff`; it does not mean “status or diff.” `argsPrefix` and
`argsPrefixes` are mutually exclusive in one rule. Omitting both allows that
executable with any safely tokenized arguments.

An allow-list may also import exact command strings from the run's most recent
human-reviewed gate artifact:

```yaml
mode: allow-list
allow:
  - executable: git
    argsPrefix: [status]
approvedSources: [verification-worker]
```

Supported sources are:

| Source                  | Reviewed JSON path                                                    |
| ----------------------- | --------------------------------------------------------------------- |
| `verification-worker`   | `repositories[].worker[].command`                                     |
| `verification-reviewer` | `repositories[].reviewer[].command`                                   |
| `remote-actions`        | `actions[]` where `toolName` is `bash` and `input.command` is present |

The JSON must be the whole reviewed artifact or appear in a fenced `json`
block. The harness copies only exact strings into the correlated step policy.
Verification sources reject shell wrappers, remote-transfer programs,
`gh`/`glab`, publishing commands, and non-local Git operations. Remote actions
accept only `gh api`, `glab api`, or non-force `git push`. A model cannot widen
an approved command by adding arguments or shell composition.

Approved sources fail closed until a gate has actually been approved. Ordinary
step summaries never become command provenance. Legacy v1 checkpoints remain
readable, but they receive no reviewed-command capabilities until a new gate
produces an approved artifact.

Static allow-list rules for `gh api` and `glab api` are GET-only: mutation
flags such as fields, input, forms, or an explicit method are blocked. A
mutating API call therefore needs an exact `remote-actions` command from a
reviewed artifact.

#### How `approvedSources` works

`approvedSources` does not allow an executable, run a command, or read from the
current step summary. It tells the harness which fixed field in the most recent
human-approved artifact may contribute exact command strings. Approval may
come from the built-in Pi prompt gate or Plannotator.

For example, suppose the approved artifact contains:

```json
{
  "repositories": [
    {
      "worker": [{ "command": "bun test" }]
    }
  ]
}
```

A later step with `approvedSources: [verification-worker]` may run exactly
`bun test`. It may not run `bun test --watch`, because that is a different
string. `verification-reviewer` reads the sibling `reviewer` list instead.
`remote-actions` reads only Bash actions from `actions[]` and additionally
filters them to supported hosted-API mutations or non-force pushes.

The complete path is:

```text
step artifact -> human approval -> persisted reviewed artifact
-> source-specific extraction -> correlated step policy -> exact string check
```

If no gate has been approved, the selected field is absent, the command is
unsafe for that source, or the string differs at all, no permission is added.

Hard turn and tool-call budgets are best for read-only inspection and
verification steps. For a step that edits files, use a generous timeout and no
hard count budget unless partial edits are acceptable; inspect the working tree
after any interruption before resuming.

## Built-in review gate

Human review works without Plannotator. Omit `provider` (or set it to `prompt`)
to use Pi's built-in prompt panel:

```yaml
gate:
  submitOutcome: submit
  approvedOutcome: approved
  rejectedOutcome: changes-requested
transitions:
  approved: implement
  changes-requested: plan
  blocked: $pause
```

When the step completes with outcome `submit`, it must include the full content
in `artifact`. Pi shows Approve, Request changes, and Pause workflow. Requested
changes are returned through `{{gate.feedback}}`; approval persists the
artifact as the reviewed handoff. Dismissing the panel pauses the workflow and
keeps the pending artifact, so `/workflow-resume` reopens the same review.

Dialog-capable UI is available in Pi TUI and RPC modes. In print or JSON mode,
the gate pauses safely until resumed in TUI or RPC.

## Works great with Plannotator

[Plannotator](https://github.com/backnotprop/plannotator) gives Pi a local,
browser-based surface for visually reviewing and annotating plans. It is
optional, but highly recommended for rich plan feedback. Install its Pi
extension alongside Pi Workflows:

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

```yaml
gate:
  provider: plannotator
  submitOutcome: submit
  approvedOutcome: approved
  rejectedOutcome: changes-requested
  timeoutMs: 5000
transitions:
  approved: implement
  changes-requested: plan
  blocked: $pause
```

Setting `provider: plannotator` is the entire opt-in; the harness preflights the
installed extension automatically. The active step calls
`workflow_complete_step` with outcome `submit` and the full content in
`artifact`. The harness correlates the Plannotator review identifier and
accepts only the matching decision. On approval, that reviewed artifact—not
the step's separate summary—becomes the authoritative handoff to the next step.

If review finishes while the workflow is paused, the result is checkpointed and applied only after `/workflow-resume`. Resume also queries Plannotator’s durable review status, so a decision made while Pi was closed is not lost.

## Pause, repair, resume

Use:

```text
/workflow-pause <optional reason>
```

The harness stops the active main-agent turn, dismisses a built-in review, or
sends the versioned pi-subagents cancellation event for a delegated step. It
keeps the exact current step and pending gate, then persists the checkpoint in
the Pi session. A late completion cannot advance a paused, aborted,
reconfigured, or replaced run.

When a step itself transitions to `$pause`, the checkpoint keeps both the
incoming reviewed/previous-step handoff and the latest failed-attempt summary.
The resumed execution sees both. Exact reviewed commands continue to derive only
from the separately persisted reviewed artifact, never from the failed attempt
or a legacy unreviewed summary.

For a delegated step, if child termination is not confirmed within five
seconds, the pause is recorded but main tools remain isolated and resume is
blocked. Wait for the terminal event; if the delegation channel has already
failed, restart Pi before resuming. This prevents an old writer and a resumed
writer from overlapping.

While paused, fix repository code, workflow YAML, prompts, MCP configuration,
an extension, or any other environmental problem. Then run:

```text
/workflow-resume
```

Resume reloads configuration before continuing:

- The paused step restarts in its configured main-agent or delegated mode.
- A changed current step restarts that step.
- A changed completed step restarts the earliest changed completed step.
- Future-only changes preserve the current checkpoint.
- Removing the current or a completed step fails closed and requires restoring configuration or aborting.
- Restoring a Pi session automatically pauses an in-progress workflow for inspection.
- A pending built-in prompt review reopens with the same artifact.
- An interrupted Plannotator submission without a review identifier restarts the current step for resubmission.

## Commands

In TUI mode, `/workflow-status` opens a read-only board for the current
checkpoint. It refreshes once per second and shows run timing, the current
execution or review, pause reasons, configuration drift, and the completed
attempt path. Press `q`, `Esc`, `Ctrl-C`, or `Ctrl-D` to close it. Non-TUI modes
receive the same checkpoint as text.

| Command                         | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `/workflow-list`                | List loaded workflows and their configured commands.  |
| `/workflow-start <id> [input]`  | Start by workflow identifier.                         |
| `/<configured-command> [input]` | Start through a workflow alias.                       |
| `/workflow-status`              | Open a live run-status board (text outside TUI mode). |
| `/workflow-pause [reason]`      | Halt without losing the checkpoint.                   |
| `/workflow-resume`              | Reload, reconcile, and continue.                      |
| `/workflow-abort [reason]`      | End the active run and restore baseline tools.        |
| `/workflow-reload`              | Reload definitions while no workflow is running.      |

## User and project configuration

User workflows are loaded first. A project may add workflows from:

```text
<project>/.pi/workflows/*.workflow.yaml
<project>/.pi/workflows/*.workflow.yml
```

Project workflows are disabled by default. Enable them in the user-owned
`~/.pi/agent/workflows/settings.yaml`:

```yaml
# yaml-language-server: $schema=/absolute/path/to/pi-workflows/schemas/settings.schema.json
version: 1
allowProjectWorkflows: true
permissionCeiling:
  tools: [read, grep, bash]
  mcp: []
  extensions: []
  skills: []
  bash: { mode: read-only }
  subagent:
    agents: [pi-workflows.step, scout, worker, reviewer]
    contexts: [fresh]
    models: []
    maxTimeoutMs: 900000
    maxTurns: 40
    maxGraceTurns: 3
    maxToolCalls: 100
    artifacts: false
```

Settings use the same strict YAML 1.2 parser as workflow definitions. The
`settings.schema.json` file remains JSON Schema so YAML-aware editors can
validate `settings.yaml`; adjust or remove the schema comment for your install
path.

Project workflows load only when Pi trusts the project and every step stays
within this ceiling. The `subagent` ceiling is optional for main-only project
workflows; if omitted, any project step that declares `subagent` is rejected.
Each delegated project step must declare `turnBudget` and `toolBudget` with
`"block": "*"`, so it cannot silently inherit unbounded child defaults or keep
mutation tools after reaching the hard limit. The ceiling also controls child
agent names, context inheritance, model overrides, timeouts, artifact
retention, and the Bash rules and approved sources that a project workflow may
request. Project workflows cannot override user workflow identifiers or
commands.

## Architecture

The package keeps the Pi entry point intentionally small:

| Module                            | Responsibility                                                        |
| --------------------------------- | --------------------------------------------------------------------- |
| `src/index.ts`                    | Pi entry point only.                                                  |
| `src/harness.ts`                  | Runtime orchestration and session lifecycle.                          |
| `src/commands.ts`                 | User command surface.                                                 |
| `src/config/`                     | Types, strict validation, prompt loading, precedence, ceilings.       |
| `src/engine/`                     | Serializable run state and deterministic transitions.                 |
| `src/policy/`                     | Tool, MCP, and Bash enforcement.                                      |
| `src/policy/approved-commands.ts` | Filtered exact-command extraction from human-reviewed JSON artifacts. |
| `src/integrations/subagents/`     | Delegation client, child protocol, and child policy runtime.          |
| `src/integrations/plannotator.ts` | Versioned Plannotator gate adapter.                                   |
| `src/integrations/prompt-gate.ts` | Built-in Pi prompt review adapter.                                    |
| `src/runtime/`                    | Shared completion parsing and main-agent step runtime.                |
| `src/preflight.ts`                | Required tool, extension, and skill checks.                           |
| `src/prompt.ts`                   | Template rendering and step contract.                                 |
| `agents/step.md`                  | Bundled dynamic-policy pi-subagents profile.                          |

The engine and policy modules do not depend on Pi runtime types, so they are fast to test.

## Security model

Pi extensions are not an operating-system sandbox. Installed extensions execute with the user’s process permissions.

The harness provides model-level least privilege in both execution modes, plus
process separation when a step opts into pi-subagents:

- active-tool narrowing for every step;
- authoritative `tool_call` blocking and immutable authorized arguments;
- completion as the sole call in its tool batch;
- optional separate pi-subagents child process per delegated step;
- an idle, tool-isolated main agent while a delegated step runs;
- a single-use, parent-created child capability tied to the selected workflow agent;
- explicit MCP server and tool checks;
- restricted Bash parsing;
- exact Bash capabilities derived from a correlated human-reviewed artifact;
- project trust and a user-owned permission ceiling;
- fail-closed durable state, correlated child results, and correlated gate results.

It does not restrict commands the human explicitly runs with Pi’s `!` Bash
input. In main-agent mode it cannot hide globally loaded skills or isolate the
transcript. In either mode it cannot disable side effects performed
autonomously by a loaded extension. Review workflow, agent, and extension
source before installing or enabling it.

Step completion is structurally validated—policy digest, declared outcome,
non-empty bounded summary, required gate artifact, and sole completion call—but
the harness cannot prove that a model's semantic claims or test evidence are
true. Put exact checks in reviewed command contracts, use an independent
verification step, and keep consequential actions behind a human gate.

The harness does not provide exactly-once external effects. If a publish step
is interrupted after a remote action succeeds but before it checkpoints, a
resumed execution receives the same approved capability. Publish prompts should
query the remote effect first, skip only proven-complete actions, and pause on
ambiguous state.

## Development

```bash
bun install
bun run check
```

Tests cover graph validation, prompt confinement, command conflicts, project
ceilings, deterministic transitions, configuration reconciliation, pause/resume
state, gate handling, MCP isolation, Bash policy, extension tool selection,
main-agent completion, built-in feedback/approval, subagent request correlation
and cancellation, child policy enforcement, and dependency preflight,
including reviewed exact-command propagation and fail-closed legacy
checkpoints.

## Publishing checklist

Before publishing:

1. Confirm the package name and repository metadata.
2. Run `bun run check`.
3. Merge a Conventional Commit PR and verify its GitHub Release artifact.

The `pi-package` keyword makes the package discoverable by the Pi package gallery.

## Good next parameters

The current schema covers the execution harness requested here. Useful future
extensions, without hard-coding them into the orchestrator, are:

| Parameter                         | Why it belongs in configuration                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Retry and backoff                 | Let a step distinguish a transient child failure from a workflow-level pause.               |
| Acceptance criteria               | Give each step machine-checkable completion evidence and verification commands.             |
| Working directory or worktree     | Isolate mutating steps, monorepo packages, and concurrent branches.                         |
| Parallel groups and join policy   | Run independent steps together and declare fail-fast, quorum, or all-success behavior.      |
| Generic gates                     | Add ticket, CI, chat, or custom approval providers behind the same versioned gate contract. |
| Output schema and named artifacts | Pass structured data between steps instead of relying only on a summary.                    |
| Cost and token ceilings           | Bound model spend independently from turn and tool-call budgets.                            |
| Environment and secret references | Select named credentials without embedding secret values in workflow files.                 |
| Logging and retention             | Configure progress events, redaction, child artifact retention, and checkpoint history.     |

## Current limits

- A delegated workflow step uses one foreground subagent. Parallel or chained children inside one step are not yet a workflow-level primitive.
- Gate providers are built-in prompt and Plannotator; custom providers are not yet configurable.
- A custom subagent profile can be narrower than a step, but Pi Workflows cannot widen that profile.
- Extension tools are enforced; autonomous extension event-handler side effects cannot be disabled per step.
- Completion evidence is model-reported; use reviewed executable checks and a fresh verification step when correctness matters.
- Workflow configuration uses YAML. Prompt bodies may live in separate Markdown files.

## License

Licensed under the [Apache License 2.0](./LICENSE).
