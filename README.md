# Pi Workflows

**Turn repeatable agent work into declarative, pauseable workflows that cannot
silently loop forever.** Put the steps, tools, prompts, approvals, and outcomes
in YAML; Pi Workflows supplies durable checkpoints, finite automatic execution,
and a live status view without learning your language, framework, or process.

[![codecov](https://codecov.io/gh/wichayutdew/pi-workflows/graph/badge.svg?token=33xrCBRM82)](https://codecov.io/gh/wichayutdew/pi-workflows)

```bash
pi install npm:@wichayutdew/pi-workflows
```

- Compose main-agent and isolated subagent steps from one strict YAML contract.
- Pause for built-in or Plannotator review, then resume the same checkpoint.
- Reject dead-end graphs up front and pause bounded cycles at `maxStepVisits`.
- Keep every domain decision in your workflow files—not in the harness.

## Overview

Pi Workflows keeps orchestration code generic and moves workflow behavior into
small YAML configuration and prompt files. Each workflow defines its
own steps, transitions, execution mode, tool access, MCP access, Bash policy,
extensions, skills, dependency checks, and optional human-review gate.

The harness owns state transitions. A step runs in the main Pi agent by default,
or in a separate [pi-subagents](https://github.com/nicobailon/pi-subagents)
child when it declares `subagent`. Main-agent steps advance through
`workflow_complete_step`; delegated steps return the same validated contract
through pi-subagents' correlated `structured_output`.

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
the best isolation and review experience. Delegated steps require
pi-subagents `0.36.0` or newer. Run `/subagents-doctor` if an explicitly
delegated step cannot start.

Pi loads `src/index.ts` through the package manifest. Restart Pi or run `/reload` after changing extension source.

## Quick start: bootstrap four practical workflows

The checked-in [`examples/starter-kit`](./examples/starter-kit) is a portable,
user-owned starting point for:

| Command       | Included flow                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `/work`       | Prepare or reuse one dedicated Git worktree, plan, approve, implement, and verify local work.              |
| `/ticket`     | Prepare or reuse one dedicated Git worktree, read a ticket, plan, approve, implement, and verify.          |
| `/mr-review`  | Fetch a hosted review, produce a child review, approve it, publish it, and verify the remote effect.       |
| `/mr-comment` | Fetch review comments, plan and approve fixes, edit only the current branch/worktree, verify, push, reply. |

The starter YAML explicitly selects Pi Subagents' standard role profiles:
`scout` for evidence gathering, `planner` for implementation plans, `worker`
for mutations and publication, and `reviewer` for independent review and
verification. Change those `subagent.agent` values when your own Pi Subagents
configuration uses different profiles. The generic `pi-workflows.step` profile
remains available for user-authored `subagent: {}` steps, but the starter kit
does not rely on it.

Install the integrations required by these four examples:

```bash
pi install npm:pi-subagents
pi install npm:@plannotator/pi-extension
```

Configure a Pi MCP proxy for the `atlassian`, `gitlab`, and/or `github` server
IDs when you want that access route. The MR examples try a matching MCP server
first but can fall back to the repository/host CLIs or cURL named in their
YAML; ensure at least one route is authenticated and available. The ticket
example requires Atlassian MCP by default. MCP server names, authentication,
tool availability, Git hosting, and repository commands are environment
choices, so adapt the selectors, `requires`, and Bash rules instead of
expecting the extension to infer them.

Copy the starter files into the user workflow directory:

```bash
mkdir -p ~/.pi/agent/workflows
cp examples/starter-kit/*.workflow.yaml ~/.pi/agent/workflows/
cp -R examples/starter-kit/steps ~/.pi/agent/workflows/
```

If files with those names already exist, review and merge them instead of
overwriting your working configuration. Then customize:

1. In `work.workflow.yaml` and `ticket.workflow.yaml`, set each
   `workspace.allowedRoots` to relative directories where the preparation
   prompt may create or reuse a worktree.
2. Replace or narrow the `atlassian`, `gitlab`, and `github` MCP selectors to
   match your configured adapter. Remove an unused host consistently from the
   relevant `permissions.mcp` blocks and prompts.
3. Review every Bash mode and executable. The starter implementation and
   verification steps are deliberately language-neutral and therefore
   unrestricted; replace them with repository-specific allow lists when
   possible. Command syntax—including package-manager argument order—belongs
   in your prompt and repository context.
4. Edit the prompt files under `steps/` to define your artifact format,
   acceptance criteria, publication policy, and organization-specific rules.
   Pi Workflows treats all of that content as opaque domain configuration.

Reload and diagnose every graph before the first run:

```text
/reload
/workflow-reload
/workflow-doctor work
/workflow-doctor ticket
/workflow-doctor mr-review
/workflow-doctor mr-comment
```

Start them from the repository checkout that should supply the initial
workspace:

```text
/work update the navigation
/ticket PROJ-123 retry failed requests
/mr-review https://gitlab.example.com/group/project/-/merge_requests/42
/mr-comment https://github.com/example/project/pull/42
```

`/work` and `/ticket` bind the exact worktree returned by their user-authored
preparation prompt. `/mr-comment` intentionally has no workspace-binding step:
every child stays on the branch and worktree from which the run started.
Requested changes return only to the gated plan or review step with the user's
feedback; they never restart workspace preparation or the whole workflow. The
starter `/work` and `/ticket` planners use a separate `workspace-refresh`
outcome only for source-ancestry drift. It revisits preparation in the same
canonical worktree; the prompt may safely rebase its clean run-owned branch but
can never bind a replacement directory.
Remote publication prompts first check whether an approved effect already
exists because the harness cannot guarantee exactly-once external side effects.

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

Set `PI_WORKFLOWS_DIR` to use another directory. For a complete portable
starting point, copy the four-workflow starter kit above. Every configured
command is also available as `/workflow-start <workflow-id> [input]`.

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
        mode: allow-list
        allow:
          - executable: git
            argsPrefixes: [[status], [diff]]
          - executable: rg
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
          - executable: project-check
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

| Field             | Required | Default | Description                                                                               |
| ----------------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `version`         | Yes      | —       | Configuration contract version. Currently `1`.                                            |
| `id`              | Yes      | —       | Stable workflow identifier.                                                               |
| `command`         | Yes      | —       | Slash command without `/`.                                                                |
| `description`     | Yes      | —       | Command description.                                                                      |
| `start`           | Yes      | —       | First step identifier.                                                                    |
| `steps`           | Yes      | —       | Step map. Order is controlled by transitions, not file order.                             |
| `maxStepVisits`   | No       | `5`     | Loop guard for each step.                                                                 |
| `summaryMaxChars` | No       | `4000`  | Maximum step `summary` length. Gate artifacts use their separate 200,000-character limit. |

Each step supports:

| Field         | Required | Description                                                                                           |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `title`       | No       | Human-readable name. Defaults to the step identifier.                                                 |
| `prompt`      | Yes      | Inline text or `{ "file": "relative/path.md" }`.                                                      |
| `subagent`    | No       | Opt into isolated delegation and select the Pi Subagents profile and execution budgets.               |
| `permissions` | No       | Resources callable during this step. Everything defaults to denied.                                   |
| `requires`    | No       | Dependencies that must be detectable before the step starts.                                          |
| `transitions` | Yes      | Exact outcome to next step, `$pause`, or `$done`.                                                     |
| `gate`        | No       | Built-in prompt or Plannotator human-review gate.                                                     |
| `workspace`   | No       | Bind one delegated step result as the working directory for all reachable downstream delegated steps. |

Supported prompt variables:

```text
{{workflow.input}}
{{workflow.id}}
{{run.id}}
{{step.id}}
{{step.title}}
{{last.summary}}
{{reviewed.artifact}}
{{reviewed.feedback}}
{{gate.artifact}}
{{gate.feedback}}
{{resume.input}}
```

Unknown variables fail configuration loading.

`{{last.summary}}` normally contains the previous completed step's handoff.
During a step-requested `$pause` or same-step human gate revision, it contains
both the preserved incoming handoff and latest current-step summary. Gate
artifacts and summaries stay separate: prompts opt into an opaque approved
artifact through `{{reviewed.artifact}}` or the latest rejected artifact
through `{{gate.artifact}}`.
`{{resume.input}}` contains guidance supplied to the current attempt through
`/workflow-resume [guidance]`. If a prompt omits that variable, the harness
adds the guidance in a clearly delimited standard section, so every workflow
can still use it. Standard-section guidance is an authoritative task-level
amendment for that retry, but it cannot change the workflow graph or bypass
YAML-enforced resource and workspace boundaries. The value is replaced on each
explicit resume and cleared after the step returns an outcome.

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
`timeoutMs: 900000`, `artifacts: false`, and `retryToolFailures: false`. The
`agent` value is the actual Pi Subagents profile launched for that step.
`fresh` is the only supported workflow-step context: each child receives the
original workflow input and the previous step's compact handoff, never the
parent or a sibling transcript.

The run captures Pi's current working directory when it starts. Without a
`workspace` binding, every delegated visit—including cycles, retries, and
resumed steps—uses that directory.

One delegated, non-gated step may bind a different directory through structured
result data:

```yaml
workspace:
  bindOn: [ready]
  allowedRoots: ['..']
```

On a binding outcome, the result must include
`workspace: { cwd: "/absolute/directory" }`. The harness resolves its real path,
requires an existing directory under one configured root relative to the
run-start directory, persists that canonical identity, and passes it to every
reachable downstream child, revisit, recovery attempt, and resume. If the sole
binding step is revisited, it may re-affirm the same canonical directory; a
different directory is rejected. Other outcomes must omit `workspace`. All
reachable nonterminal steps after a binding must be delegated because the main
Pi process cannot change its working directory.

The workflow prompt owns how the directory is prepared and what it represents.
The harness does not know Git, worktrees, languages, frameworks, or command
syntax, and it never derives a directory from summaries or gate artifacts. The
starter kit's guarded rebase policy is therefore prompt-owned domain behavior,
not extension behavior. A legacy checkpoint without a captured directory fails
closed before delegation; abort it and start a new run.

Use a profile name directly when only the child profile changes:

```yaml
steps:
  inspect:
    subagent: scout
    prompt: Inspect the request.
    transitions:
      done: $done
```

This name-only form inherits the same execution defaults and launches the
configured Pi Subagents `scout` profile. Its system prompt and profile defaults
provide the specialty, while the workflow prompt supplies the exact step
contract. Use the object form when the step also needs a model, timeout, budget,
or artifact override:

```yaml
subagent:
  agent: reviewer
  context: fresh
  timeoutMs: 600000
```

Pi Workflows passes `subagent.agent` directly to Pi Subagents. Built-in profiles
such as `scout`, `planner`, `worker`, and `reviewer` therefore retain their own
system prompts, models, and specialty defaults. The bundled
`pi-workflows.step` profile remains the default general-purpose profile when
`agent` is omitted.

Every delegated request sets `context: fresh`, `output: false`, an
`outputSchema` for the workflow result, and `agentContract: { version: 1 }`.
Pi Subagents supplies `structured_output`, validates the schema, and emits the
single correlated terminal response. Pi Workflows' child policy independently
validates the declared outcome and compact handoff before the parent advances.
Request-level model, timeout, turn-budget, tool-budget, skills, and artifact
options are still forwarded. Use `/subagents-models <agent>` to inspect the
selected profile and `/subagents-doctor` to diagnose discovery or loading
problems. Workflow project trust and permission ceilings remain separately
configured in `~/.pi/agent/workflows/settings.yaml`.

Supported fields:

| Field               | Default               | Description                                                                                                                                                                                    |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`             | `pi-workflows.step`   | Actual Pi Subagents profile, such as `scout`, `planner`, `worker`, or `reviewer`.                                                                                                              |
| `context`           | `fresh`               | Always isolated; parent and sibling transcripts are never inherited.                                                                                                                           |
| `model`             | Profile/default model | Optional pi-subagents model override for the selected profile.                                                                                                                                 |
| `timeoutMs`         | `900000`              | Child deadline, from 1 second through 24 hours.                                                                                                                                                |
| `turnBudget`        | pi-subagents default  | `{ "maxTurns": n, "graceTurns": n }`.                                                                                                                                                          |
| `toolBudget`        | pi-subagents default  | `{ "soft": n, "hard": n, "block": "*" }`; `block` may instead be a tool-name array.                                                                                                            |
| `artifacts`         | `false`               | Ask pi-subagents to retain its normal run artifacts.                                                                                                                                           |
| `retryToolFailures` | `false`               | Authorize the bounded automatic recovery sequence in allow-list or unrestricted Bash mode; every failed attempt still needs a complete audit proving that its actual calls were mutation-safe. |

Pi Workflows installs an inert listener in every Pi Subagents child and
activates policy only after a valid, single-use workflow capability arrives, so
ordinary subagent runs remain unchanged. Delegated completion uses the
`structured_output` tool provided by Pi Subagents; `workflow_complete_step`
remains the completion tool only for main-agent steps.

After capability verification, Pi Workflows resolves the step permissions
against every tool registered in the child and activates only that exact set,
plus the upstream structured completion tool. The selected profile's ordinary
active-tool allow-list is not a second workflow policy. Profile extension
loading still controls which extension providers exist in the child; a workflow
cannot activate a tool whose provider was not loaded.

Workflow `permissions.skills` is sent as Pi Subagents' request-level skill
selection, so it replaces the selected profile's normal skill list for that
step; an empty list disables injected skills. `output: false` prevents a
profile-default output file, while omitting acceptance under agent contract v1
avoids a second acceptance gate. The schema, harness, declared outcomes, and
optional human review gate own correlated completion.

At runtime:

1. The harness creates a correlated child policy and result channel.
2. pi-subagents starts one foreground child using the step's configured agent profile.
3. The child runtime activates the workflow-permitted registered tools and validates `structured_output`.
4. The parent waits for the correlated terminal response, applies the transition, and launches the next fresh-context step.

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

The generic `mcp` proxy is the portable choice for workflow steps. The bundled
runtime may also expose direct MCP tools through Pi Subagents settings; Pi
Workflows still requires each direct runtime name in `tools`.

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

| Mode           | Behavior                                                            |
| -------------- | ------------------------------------------------------------------- |
| `deny`         | Blocks Bash. This is the default.                                   |
| `allow-list`   | Allows one executable plus user-configured argument prefixes.       |
| `unrestricted` | Allows any Bash command. Use only in trusted, user-owned workflows. |

Allow-list mode rejects shell operators, substitutions, expansions, wrapper
shells, and environment assignments before matching the declarative rule.

Allow-list entries are OR alternatives. `argsPrefix` is one ordered token
sequence:

```yaml
mode: allow-list
allow:
  - executable: git
    argsPrefix: [status]
  - executable: project-check
    argsPrefix: [test]
```

This permits `project-check test --focused` but not `project-check build`.

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

The engine deliberately has no package-manager, language, framework, Git, or
hosted-API command knowledge. It does not rewrite command argument order and
does not derive Bash authority from prompts, summaries, or gate artifacts.
Command meaning and syntax belong to the step prompt and the agent's own
context; executable scope belongs entirely to the YAML `allow` rules.

Hard turn and tool-call budgets are best for non-mutating inspection and
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
artifact as `{{reviewed.artifact}}` while the step's `summary` remains the
compact handoff. Here, `changes-requested: plan` immediately runs a fresh
attempt of that exact gated step with the rejected draft in
`{{gate.artifact}}`, the original incoming step handoff, and the new feedback,
then opens another review. Use
`changes-requested: $pause` instead when revision should require an explicit
`/workflow-resume`. Dismissing the panel keeps the pending artifact, so
`/workflow-resume` reopens the same review.

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
- Requested changes follow the workflow's configured transition with structured
  feedback.
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
  timeoutMs: 30000
transitions:
  approved: implement
  changes-requested: plan
  blocked: $pause
```

Setting `provider: plannotator` is the entire opt-in; do not also grant the
planning child Plannotator extension tools. The harness preflights the installed
extension automatically. A main-agent planning step calls
`workflow_complete_step`; a delegated planning child calls
`structured_output`. In either case it uses the configured submit outcome and
places the review content in `artifact`. The harness correlates the Plannotator
review identifier and accepts only the matching decision. On approval, the
artifact is preserved as an opaque template value; the separate `summary`
remains the next step's compact handoff.

The `approved` boolean from Plannotator is authoritative; feedback text and
annotation labels stay opaque. A rejection follows only the YAML transition
shown above. A same-step rejection is an explicitly human-controlled revision
loop, so that human-mediated transition bypasses the visit-limit check and may
continue until approval. The visit is still recorded, and later automatic
entries remain guarded. A same-step agent retry during revision preserves the
incoming handoff, rejected artifact, and feedback, but it does not bypass the
visit-limit check. Gate feedback is capped at 50,000 characters; history and
user notifications use a compact rejection summary while `{{gate.feedback}}`
receives the bounded full value.

The artifact is never substituted for a missing summary. If an older pending
gate has no separately stored summary, its transition uses an empty compact
handoff.

If review finishes while the workflow is paused, the result is checkpointed and applied only after `/workflow-resume`. Resume also queries Plannotator’s durable review status, so a decision made while Pi was closed is not lost.

### Artifact format belongs to the workflow

Pi Workflows imposes no plan headings, acceptance-criteria layout,
machine-readable appendix, command schema, or other Plannotator prompt format.
The step's YAML prompt defines what the artifact means and how downstream steps
use `{{reviewed.artifact}}`. Outcome names are equally opaque: names such as
`approved`, `retry`, or `replan` have only the transitions and meanings the
workflow author gives them.

In print or JSON mode, a pending built-in plan review remains safely paused.
Reopen the same session in TUI or RPC mode and run `/workflow-resume` to show
the preserved review instead of restarting the planning child.

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
incoming previous-step handoff and the latest failed-attempt summary. The
resumed execution sees both. The run-start directory, any accepted workspace
binding, and any separately persisted reviewed artifact are preserved without
being interpreted.

Every settled step also posts one visible chat summary without starting another
agent turn. Successful and `$pause` outcomes show only the step's validated
`summary`; the final one also states that the workflow completed. Manual,
restored-session, and review pauses show their concise pause reason. Runtime
failures show only a short, redacted failure summary—not the task, artifact,
tool transcript, or full diagnostic. Complete evidence remains available in
the status explorer.

For a delegated step, if child termination is not confirmed within five
seconds, the pause is recorded but main tools remain isolated and resume is
blocked. Wait for the terminal event; if the delegation channel has already
failed, restart Pi before resuming. This prevents an old writer and a resumed
writer from overlapping.

When a delegated child returns `failed`, `structured_output_failed`,
`timed_out`, `turn_budget_exhausted`, or `tool_budget_exhausted`, the harness
audits the retained Pi child session before deciding whether to launch a fresh
automatic recovery child. The audit accepts only regular, non-symlink session
files contained by the current parent session's child-run root, requires the
persisted policy-stripped task and its per-request binding to match the active
delegation, reads a bounded complete tail, and proves that every recorded call
used a known-safe non-Bash tool or was rejected by policy before execution.
A zero-tool attempt is also replay-safe when the complete bound transcript
proves it. Executed Bash is treated as an unknown effect; automatic recovery
requires explicit authorization and still cannot claim that a domain-specific
command was non-mutating.

When the terminal error identifies a failed tool, the harness also records the
exact correlated call, tool error, subagent exit code, terminal error, and
validated diagnostic session path. If exact correlation is unavailable, the
generic terminal evidence is retained without claiming an unrelated command.
A failed process status is treated as resolved when the transcript proves a
successful `structured_output` occurred after every failed tool result and the
correlated result validates. This accepts the same finalized child result; it
never replays mutation-capable work.

Without a valid finalized result, the next fresh child receives the bounded
history of distinct terminal evidence in an escaped JSON data boundary and is
told to inspect current state, change its approach, resolve the cause, and
finish the original step. The harness launches at most two automatic recovery
children and stops early when the semantic failure fingerprint repeats.
Availability of `edit` or `write` is not itself a veto: the complete audit must
prove that the failed attempt did not actually make or attempt a mutation.
Mutation-capable or unknown-effect calls, reported file mutation, a truncated or
malformed transcript, a missing active-request binding, cancellation,
interruption, detached or stopped execution, and protocol/configuration errors
remain hard stops. Local channel failures also wait for confirmed child
termination instead of risking two live children.

Temporary delegation-workspace removal is best-effort housekeeping. A cleanup
error produces a warning but cannot pause an otherwise healthy next step or
recovery child. Synchronous startup exceptions are contained by the serialized
failure path. Each recovery uses a new request identity, private result
capability, and fresh context. The fixed two-attempt bound means a failing step
can consume at most three times its per-child timeout, turn budget, and tool
budget.

Inside a live child, recovery is not tied to a list of known error strings. The
agent receives the exact error and current state, then follows the user-authored
step prompt and configured outcomes. The engine does not assign a recovery,
pause, or replanning meaning to any outcome name.

While paused, fix repository code, workflow YAML, prompts, MCP configuration,
an extension, or any other environmental problem. Then run:

```text
/workflow-resume inspect the existing partial output before retrying
```

Resume reloads configuration before continuing:

- Optional text after `/workflow-resume` is passed as a user-authored
  task-level amendment for this attempt. It may supersede conflicting prompt or
  handoff instructions, but never YAML-enforced resource or workspace policy.
- The paused step restarts in its configured main-agent or delegated mode.
- A changed current step restarts that step.
- A changed ordinary completed step restarts the earliest changed completed step.
- A completed human-approved gate keeps its opaque reviewed artifact; later prompt or configuration digest changes do not reopen that gate while its configuration and approved outcome still match.
- Future-only changes preserve the current checkpoint.
- Removing the current or a completed step fails closed and requires restoring configuration or aborting.
- Restoring a Pi session automatically pauses an in-progress workflow for inspection.
- A pending built-in prompt review reopens with the same artifact.
- An interrupted Plannotator submission without a review identifier restarts the current step for resubmission.

## Commands

The full status overlay is an on-demand verification and history page. Toggle
it with `Ctrl+Alt+W` by default (`q` or `Esc` hides the board). Set
`statusShortcut` in `settings.yaml` to another Pi key identifier, then run Pi's
`/reload` to re-register it; `/workflow-reload` cannot change extension
shortcuts. The overlay shows run timing, execution or review, pause reasons,
configuration drift, and the completed attempt path without a task-viewer pane
below the editor. The main surface shows only one small animated
`◐`/`◓`/`◑`/`◒` working
indicator followed by the workflow id and current step title/id while a
workflow runs, then clears it when execution stops. This makes live progress
visible without opening the status page. All attempt logs, history, failure,
and review detail stays in the overlay. There, `✓` marks a completed step, `✕`
a failed or aborted run, and `◆` a paused step or pending review.

Use `↑`/`↓` or `j`/`k` to select a step, then `Enter`, `→`, or `l` to inspect
the bounded task supplied to each attempt, its result and gate decision, and a
chronological execution log when available. In the detail view,
`↑`/`↓` or `j`/`k` scrolls one line, while `Ctrl+D` and `Ctrl+U` scroll down and
up by half a page. `gg` jumps to the top and `G` jumps to the bottom. `←`, `h`,
or `Esc` returns to the board; `q` or the configured shortcut closes it.
PgUp/PgDn and Home/End retain page navigation.
Trace references and bounded task/result evidence live in the checkpoint, so
completed, paused, resumed, and restored runs remain inspectable. Child logs
are path-confined, size-bounded, control-sanitized, and redact common
credential forms.
For new main-agent attempts, the extension arms only on the exact workflow
task and checkpoints a redacted, size-bounded prefix of finalized assistant
and tool events in source order. This log remains part of the parent session,
but the explorer never reads unrelated parent-session traffic. Legacy
checkpoints without a main-agent log still show their bounded task and result.
Long reasons are clamped to the display width while the durable checkpoint
retains the full reason.

| Command                         | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `/workflow-list`                | List loaded workflows and their configured commands.      |
| `/workflow-doctor [id]`         | Diagnose completion paths, unreachable steps, and cycles. |
| `/workflow-start <id> [input]`  | Start by workflow identifier.                             |
| `/<configured-command> [input]` | Start through a workflow alias.                           |
| `/workflow-pause [reason]`      | Halt without losing the checkpoint.                       |
| `/workflow-resume [guidance]`   | Reload, reconcile, and continue with an optional hint.    |
| `/workflow-abort [reason]`      | End the active run and restore baseline tools.            |
| `/workflow-reload`              | Reload definitions while no workflow is running.          |

Before a workflow starts or resumes, the doctor rejects graphs whose start
cannot reach `$done` or whose reachable branches contain a step that cannot
reach `$done`.
Unreachable steps and cycles are reported as warnings; a cycle with an exit may
run, but `maxStepVisits` pauses the uninterrupted run before a step can execute
more than its configured limit. An explicit resume can continue from that
checkpoint, so the guard bounds automatic graph advancement rather than
guaranteeing completion or wall-clock duration. An explicit human gate
rejection back to that same gated step bypasses the check for that transition;
the visit remains recorded and every iteration must stop for another human
decision.

Configured aliases also accept multiline input. For example, if `work` is a
loaded workflow command, Pi Workflows normalizes:

```text
/work
"""inspect and update this repository"""
```

to the same command with an argument instead of letting the raw multiline text
start an unrelated parent-agent turn.

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
statusShortcut: ctrl+alt+w
permissionCeiling:
  tools: [read, grep, bash]
  mcp: []
  extensions: []
  skills: []
  bash:
    mode: allow-list
    allow:
      - executable: git
        argsPrefixes: [[status], [diff]]
      - executable: rg
  subagent:
    agents: [scout, planner, worker, reviewer]
    contexts: [fresh]
    models: []
    maxTimeoutMs: 900000
    maxTurns: 40
    maxGraceTurns: 3
    maxToolCalls: 100
    artifacts: false
    retryToolFailures: false
```

Settings use the same strict YAML 1.2 parser as workflow definitions. The
`settings.schema.json` file remains JSON Schema so YAML-aware editors can
validate `settings.yaml`; adjust or remove the schema comment for your install
path.

Project workflows load only when Pi trusts the project and every step stays
within this ceiling. The `subagent` ceiling is optional for main-only project
workflows; if omitted, any project step that declares `subagent` is rejected.
Project workflows cannot declare `workspace` binding at all, even when their
other permissions fit the ceiling. Keep workflows that create, choose, or bind
a different execution directory in the user-owned workflow directory.
Each delegated project step must declare `turnBudget` and `toolBudget` with
`"block": "*"`, so it cannot silently inherit unbounded child defaults or keep
mutation tools after reaching the hard limit. The ceiling also controls
agent profile names, fresh-context use, model overrides, timeouts, artifact
retention, and the Bash rules that a project workflow may request. Project
workflows cannot override user workflow identifiers or commands.

## Architecture

The package keeps the Pi entry point intentionally small:

| Module                            | Responsibility                                                  |
| --------------------------------- | --------------------------------------------------------------- |
| `src/index.ts`                    | Pi entry point only.                                            |
| `src/harness.ts`                  | Runtime orchestration and session lifecycle.                    |
| `src/commands.ts`                 | User command surface.                                           |
| `src/config/`                     | Types, strict validation, prompt loading, precedence, ceilings. |
| `src/engine/`                     | Serializable run state and deterministic transitions.           |
| `src/policy/`                     | Tool, MCP, and Bash enforcement.                                |
| `src/workflow-doctor.ts`          | Deterministic transition-graph liveness diagnostics.            |
| `src/integrations/subagents/`     | Delegation client, child protocol, and child policy runtime.    |
| `src/integrations/plannotator.ts` | Versioned Plannotator gate adapter.                             |
| `src/integrations/prompt-gate.ts` | Built-in Pi prompt review adapter.                              |
| `src/runtime/`                    | Shared completion parsing and main-agent step runtime.          |
| `src/preflight.ts`                | Required tool, extension, and skill checks.                     |
| `src/prompt.ts`                   | Template rendering and step contract.                           |
| `agents/step.md`                  | Default general-purpose profile plus workflow child guidance.   |

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
- a single-use, parent-created child capability tied to the delegated step;
- explicit MCP server and tool checks;
- restricted Bash parsing;
- exact user-declared Bash executable and argument-prefix rules;
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
true. Put exact checks and acceptance criteria in the workflow prompt, use an
independent verification step, and keep consequential actions behind a human
gate.

The harness does not provide exactly-once external effects. If a publish step
is interrupted after a remote action succeeds but before it checkpoints, a
resumed execution receives the same declarative step permissions. Publish
prompts should query the remote effect first, skip only proven-complete actions,
and pause on ambiguous state.

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
including bounded automatic recovery after replay-safe terminal errors,
timeouts, budget exhaustion, and nonzero exits; duplicate-failure stopping;
opaque gate artifacts; workspace binding and cwd reuse; workflow liveness
diagnostics; and fail-closed legacy checkpoints.
`bun run check` also launches real Pi RPC subprocesses, invokes
`/work`, and verifies fresh `scout`, `worker`, and `reviewer` children receive
only the explicit compact handoff from the immediately preceding step. The
real-Pi scenario binds a sibling workspace, revisits its worker once, and
verifies that every downstream visit keeps the bound cwd and receives no
undeclared `replan` outcome.

## Publishing checklist

Before publishing:

1. Confirm the package name and repository metadata.
2. Run `bun run check`.
3. Merge a Conventional Commit PR and verify its GitHub Release artifact.

The `pi-package` keyword makes the package discoverable by the Pi package gallery.

## Good next parameters

The current schema covers the execution harness requested here. Useful future
extensions, without hard-coding them into the orchestrator, are:

| Parameter                         | Why it belongs in configuration                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Configurable recovery and backoff | Replace the fixed two-attempt recovery cap with a ceiling-aware per-step transient-failure policy. |
| Acceptance criteria               | Give each step machine-checkable completion evidence and verification commands.                    |
| Parallel groups and join policy   | Run independent steps together and declare fail-fast, quorum, or all-success behavior.             |
| Generic gates                     | Add ticket, CI, chat, or custom approval providers behind the same versioned gate contract.        |
| Output schema and named artifacts | Pass structured data between steps instead of relying only on a summary.                           |
| Cost and token ceilings           | Bound model spend independently from turn and tool-call budgets.                                   |
| Environment and secret references | Select named credentials without embedding secret values in workflow files.                        |
| Logging and retention             | Configure progress events, redaction, child artifact retention, and checkpoint history.            |

## Current limits

- A delegated workflow step uses one foreground subagent. Parallel or chained children inside one step are not yet a workflow-level primitive.
- Gate providers are built-in prompt and Plannotator; custom providers are not yet configurable.
- Delegated steps require pi-subagents 0.36.0 or newer and launch the actual profile selected by `subagent.agent`.
- Extension tools are enforced; autonomous extension event-handler side effects cannot be disabled per step.
- Completion evidence is model-reported; use declarative executable checks and a fresh verification step when correctness matters.
- Workflow configuration uses YAML. Prompt bodies may live in separate Markdown files.

## License

Licensed under the [MIT License](./LICENSE).
