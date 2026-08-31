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
  Step --> Agent[optional workflow role profile]
  Step --> Budget[optional maxToolCalls]
  Step --> Permissions[permissions]
  Step --> Requires[requires preflight]
  Step --> Transitions[outcome transitions]
  Step --> Gate[optional prompt or Plannotator gate]
  Step --> Workspace[optional immutable workspace binding]
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

```yaml
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
    transitions:
      ready: implement
      blocked: $pause

  implement:
    prompt: { file: prompts/implement.md }
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

Workflow definitions use YAML with either the `.yaml` or `.yml` suffix. The
bundled JSON Schema provides structural editor feedback, including safe
relative prompt paths. The runtime loader is authoritative for relationships
that standard JSON Schema cannot derive from user-defined keys: transition and
gate outcomes, workspace binding outcomes, permission/requirement subsets,
Bash-tool coupling, and budget ordering.

## Liveness Contract

Before start or resume, Pi Workflows rejects a graph when its start cannot reach
`$done` or when any reachable step cannot reach `$done`.
`/workflow-doctor [id]` also reports unreachable steps and cyclic components in
deterministic order. Cycles that have an exit to `$done` remain valid but
produce a warning.

At runtime, `maxStepVisits` bounds uninterrupted graph advancement. After a step
has executed that many times, the next attempted entry pauses at a checkpoint.
This prevents automatic infinite cycling; an explicit resume may continue and
time spent inside a step or gate is outside this graph bound. An explicit human
gate rejection back to the same gated step bypasses the visit-limit check for
that transition: every revision retains the step's original incoming handoff,
then must return to a gate and wait for another decision. The visit is still
recorded. A same-step agent retry retains that handoff and gate context but
remains subject to the limit, so all transitions produced solely by agents are
bounded.

## Verification Repair Loops

Make a verifier return an actionable outcome to the mutation step, rather than
using `$pause` for a definite repairable finding:

```yaml
implement:
  transitions:
    ready: verify
    blocked: $pause

verify:
  transitions:
    passed: $done
    failed: implement
    retry: verify
    blocked: $pause
```

The verifier's `failed` summary becomes the next implementor's
`{{last.summary}}` handoff. It should name the exact evidence and smallest
safe fix; the implementor should return to `verify` only after applying that
fix. Keep `blocked` for stale, ambiguous, or unsafe situations. This loop is
still bounded by `maxStepVisits`; resume the durable checkpoint or raise that
workflow-specific limit when more repair rounds are appropriate.

## Tool Budgets And Handoffs

A delegated step may set `maxToolCalls` to cap productive child tool calls. This
requires a `handoff` transition that loops back to the same step:

```yaml
implement:
  maxToolCalls: 24
  transitions:
    ready: verify
    handoff: implement
    blocked: $pause
```

The child runtime reserves two additional calls for checkpointing. When the
productive budget is nearly exhausted, it warns the child to prepare a compact
handoff. Once exhausted, work tools are locked and only `structured_output`
remains available. If the child then settles without a result, the parent can
advance through the self-looping `handoff` transition with a contextual fallback
summary built from the approved plan, original request, previous handoff,
diagnostic state, and repository state. That fallback does not claim unconfirmed
work is complete; the next visit must inspect the worktree and continue the same
plan-backed step.

## Prompt Rendering

```mermaid
flowchart LR
  Input[workflow command input] --> Values[template values]
  Run[WorkflowRun] --> Values
  Step[WorkflowStep] --> Values
  Gate[gate feedback] --> Values
  Prompt[inline or file prompt] --> Render[renderTemplate]
  Values --> Render
  Render --> Task[active step task]
```

Supported variables:

| Variable                 | Source                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `{{workflow.input}}`     | Command input.                                                                                                             |
| `{{workflow.id}}`        | Workflow definition.                                                                                                       |
| `{{workflow.iteration}}` | One-based iteration; increments when a completed workflow is restarted.                                                    |
| `{{run.id}}`             | Runtime run.                                                                                                               |
| `{{step.id}}`            | Current step.                                                                                                              |
| `{{step.title}}`         | Current step.                                                                                                              |
| `{{last.summary}}`       | Previous completed handoff; during a pause or same-step revision, combines it with the current-step summary.               |
| `{{gate.artifact}}`      | Opaque artifact returned by the latest rejected or failed gate.                                                            |
| `{{gate.feedback}}`      | Latest rejected gate.                                                                                                      |
| `{{reviewed.artifact}}`  | Immutable artifact from the approved gate.                                                                                 |
| `{{reviewed.feedback}}`  | Feedback paired with that approval.                                                                                        |
| `{{resume.input}}`       | User task-level amendment supplied for the current attempt by `/workflow-resume [guidance]`; it cannot bypass YAML policy. |
| `{{restart.workspace}}`  | Exact prior workspace that a restarted iteration must rebind; empty for a first iteration.                                 |

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
  Permissions --> Skills[intended skills; injected into delegated child]
  Permissions --> Bash[bash mode and allow rules]
  Requires[requires] --> ReqTools[required tools]
  Requires --> ReqExt[required extensions]
  Requires --> ReqSkills[required skills]
  ReqTools --> Preflight[preflight before launch]
  ReqExt --> Preflight
  ReqSkills --> Preflight
```

## Bash Contract

`permissions.bash` is a generic execution boundary:

- `deny` rejects every Bash call.
- `allow-list` accepts only safely tokenized commands matching an explicit
  executable and optional ordered argument prefix.
- `unrestricted` accepts Bash calls without allow-list matching.

The extension does not know package managers, languages, frameworks, Git
operations, hosted APIs, or command-specific argument placement. It neither
rewrites commands nor extracts executable authority from prompts, summaries,
or gate artifacts. The workflow author declares executable scope in YAML, and
the agent determines command syntax from its own context.

Gate artifacts are opaque data. An approved artifact is available through
`{{reviewed.artifact}}`; the latest rejected artifact is available to its
configured transition target through `{{gate.artifact}}`. Their format and
downstream meaning belong to the workflow prompt. Outcome names are also opaque
labels whose only engine-level behavior is the transition
target declared beside them.

## Compact Bash Rules

Use `argsPrefix` for one ordered token sequence. Use `argsPrefixes` to express
several OR alternatives without repeating the executable:

```yaml
allow:
  - executable: git
    argsPrefixes: [[status], [diff], [show, --stat]]
```

This expands to three normalized rules. An empty inner alternative is rejected;
omit both fields when deliberately allowing all safely tokenized arguments for
that executable.

## Agent Profiles

Executable workflow steps name a workflow role profile with `agent`. A value
such as `agent: worker` loads that workflow-owned profile from
`~/.agents/agents/worker.md`, falling back to the bundled starter-kit profile in
`examples/starter-kit/agents/worker.md`. The profile prompt supplies the
specialty, while the workflow prompt supplies the exact step contract. If a
launched step has no `agent`, the harness cannot create its delegation plan and
pauses the workflow.

An agent profile may begin with YAML frontmatter containing `model` and
`thinking`. Those values apply to Pi workers launched for that profile. Without
frontmatter, the profile is plain Markdown role guidance.

Delegation requires pi-subagents 0.36.0 or newer. The upstream
`structured_output` tool completes delegated steps; `workflow_complete_step`
remains the main-agent completion tool. After capability verification, workflow
permissions replace the active-tool list resolved in the child. Unavailable
tools or extension providers fail closed.

Each child receives the original workflow input plus the previous step's
self-contained compact `summary`. Approved and rejected gate artifacts appear
only when the prompt explicitly uses `{{reviewed.artifact}}` or
`{{gate.artifact}}`. It never inherits the parent or sibling transcript.

## Workspace Binding

The run starts in Pi's captured absolute working directory. One delegated,
non-gated step may declare:

```yaml
workspace:
  bindOn: [ready]
  allowedRoots: ['..']
```

On a listed outcome, the structured result must include
`workspace: { cwd: "/absolute/directory" }`; every other outcome must omit it.
The harness canonicalizes the existing directory, requires it to remain under
one allowed root (relative to the run-start directory, absolute, or
home-relative such as `~/repositories/worktrees`), and accepts only one
canonical binding. A revisit to the sole binding step may re-affirm that same
directory, but cannot replace it. All reachable nonterminal descendants must
be delegated. Their first visits, cycles, recovery attempts, and resumes
receive the same bound cwd.

The prompt owns directory preparation and domain meaning. Pi Workflows neither
creates worktrees nor knows Git, package managers, languages, frameworks, or
command syntax. Summaries and gate artifacts cannot select a workspace. A
workflow may define a separate bounded transition after its binding step for
domain-specific refresh work, such as the starter kit's return to planning when
the source checkout has advanced; that policy remains user-authored prompt data.

After a completed run, `/workflow-restart [input]` starts a new iteration with
the same stable run identity and source directory. If the completed iteration
bound a workspace, the new binding outcome must reaffirm that exact canonical
path; a different or missing replacement is rejected. The previous iteration's
checkpoint remains in the append-only Pi session history, while the active
restart begins with fresh visits, gate state, and step history.

```mermaid
flowchart TD
  Agent[agent] --> Profile[user profile<br/>~/.agents/agents/name.md]
  Agent --> Fallback[bundled starter-kit profile]
  Profile --> Prompt[role prompt]
  Profile --> Model[optional model]
  Profile --> Thinking[optional thinking level]
```

## Starter Workflows

The starter kit now provides one command: `/work`. It uses the role profiles
`workspace-preparer`, `planner`, `worker`, `reviewer`, and `scout`; copy those
profiles into `~/.agents/agents/` before customizing them.

### Starter `/work` Workflow

```mermaid
stateDiagram-v2
  [*] --> intake
  intake --> plan: ready
  intake --> intake: retry
  intake --> paused: blocked
  plan --> prepare-workspace: approved
  plan --> paused: changes-requested
  plan --> plan: retry
  plan --> paused: blocked
  prepare-workspace --> implement: ready
  prepare-workspace --> plan: workspace-refresh
  prepare-workspace --> prepare-workspace: retry
  prepare-workspace --> paused: blocked
  implement --> verify: ready
  implement --> implement: retry
  implement --> paused: blocked
  verify --> publish: passed
  verify --> implement: failed
  verify --> verify: retry
  verify --> verify: blocked
  publish --> completed: published
  publish --> publish: retry
  publish --> paused: blocked
```

Business intent: normalize a requirement or optional Jira key, create and
approve a publication-aware plan, prepare the approved branch and worktree,
implement and independently verify the change, then publish the verified branch
and open review.
