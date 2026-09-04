# Orchestration Modules

This page maps the modules that load workflows, evolve persisted state, and
coordinate parent-mode execution. See
[Execution Modules](./execution-modules.md) for integrations, policy, prompts,
step runtimes, and status rendering.

## Composition Pattern

The source tree separates four dependency layers:

- **Domain modules** define shared types and constants without runtime effects.
- **Functional cores** calculate validation, transition, prompt, policy, and formatting results
  without owning external state.
- **Infrastructure adapters** bind those cores to Pi, filesystem, process,
  review-provider, runtime, and timer effects.
- **Action factories** return operations that are bound to a narrow harness
  context. `WorkflowHarness` composes those operations and injects external
  effects through `WorkflowHarnessDependencies`.

## Root Modules

| Module                          | Responsibility                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/domain/`                   | Shared configuration, run-state, step-result, policy, subagent, Plannotator, profile, status, and harness types.                     |
| `src/function/digest.ts`        | Canonicalizes values and hashes workflow state; `createDigest` makes the hash implementation injectable.                             |
| `src/function/doctor/`          | Analyzes workflow transition graphs for completion paths, trapped reachable steps, unreachable steps, and cycles.                    |
| `src/function/preflight/`       | Uses tool and skill inventories to report missing tools, extensions, skills, MCP support, Plannotator, or pi-subagents before execution. |
| `src/herdr-workflow-state.ts`   | Optional Herdr companion reporter that mirrors workflow lifecycle state to Herdr's managed pane status socket.                       |
| `src/harness.ts`                | Root compatibility export for the parent-mode `WorkflowHarness` implementation.                                                      |
| `src/index.ts`                  | Extension entry and factory. It chooses parent or child mode and injects environment, settings, harness, and child-runtime constructors. |
| `src/infrastructure/index.ts`   | Barrel for filesystem adapters, harness composition, review integrations, process clients, and runtimes.                             |

## Configuration

| Module                                       | Responsibility                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/config.ts`                       | Canonical configuration constants and types, including workflows, steps, agents, gates, permissions, settings, and diagnostics.             |
| `src/function/config/ceiling.ts`             | Proves that project-workflow permissions stay within the configured tool, MCP, extension, skill, and Bash ceiling.                         |
| `src/function/config/command-conflicts.ts`   | Detects exact and suffixed runtime command collisions.                                                                                      |
| `src/function/config/diagnostics.ts`         | Normalizes loader errors into stable diagnostic messages and codes.                                                                         |
| `src/function/config/step-digests.ts`        | Computes per-step digests with prompt text and structural digests without prompt text for reconciliation and approval provenance.           |
| `src/function/config/validate-settings.ts`   | Exports the settings validator entry points.                                                                                                |
| `src/function/config/validate-workflow.ts`   | Exports the workflow validator entry points.                                                                                                |
| `src/infrastructure/fs/catalog.ts`           | Composes the injected settings/workflow loaders, project trust checks, permission ceilings, conflict checks, and final catalog diagnostics. |
| `src/infrastructure/fs/load-settings.ts`     | Reads, parses, and validates `settings.yaml`.                                                                                               |
| `src/infrastructure/fs/load-workflows.ts`    | Enumerates a workflow directory, constrains prompt paths to that directory, validates YAML, loads prompts, and computes digests.            |
| `src/infrastructure/fs/load.ts`              | Node-backed loader facade and default `loadCatalog`/`loadSettings` functions.                                                              |
| `src/infrastructure/fs/yaml.ts`              | Parses YAML and turns parser failures into document-specific errors.                                                                        |

### Configuration Validation

| Module                                          | Responsibility                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/function/config/validation/shared.ts`      | Shared patterns, JSON-object guards, unknown-key rejection, primitive readers, and validation result types.                             |
| `src/function/config/validation/settings.ts`    | Validates settings, project-workflow controls, permission ceilings, and defaults.                                                       |
| `src/function/config/validation/workflow.ts`    | Validates the workflow document, assembles steps, checks the transition graph, and returns a normalized definition.                     |
| `src/function/config/validation/step.ts`        | Parses one step's prompt, workflow role agent, transitions, gate, artifact contract, permissions, requirements, and workspace binding. |
| `src/function/config/validation/permissions.ts` | Parses tool, extension, MCP, skill, and Bash permissions and requirements.                                                              |
| `src/function/config/validation/prompt.ts`      | Rejects unsupported prompt template variables.                                                                                          |
| `src/function/config/validation/shortcut.ts`    | Canonicalizes and validates the status keyboard shortcut.                                                                               |

## State Engine

All engine transitions return new run values; they do not perform Pi, file, UI,
timer, or subagent effects.

| Module                                           | Responsibility                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/state.ts`                            | Versioned run, history, gate, status, workspace, and step-trace types.                                                    |
| `src/function/engine/checkpoint.ts`              | Finds and validates the newest workflow checkpoint in session entries.                                                    |
| `src/function/engine/create-run.ts`              | Creates the first immutable run state from a loaded workflow and baseline tools.                                          |
| `src/function/engine/gate-transitions.ts`        | Begins review, attaches review IDs, records review failures/resolutions, and applies approved or rejected outcomes.       |
| `src/function/engine/reconciliation-history.ts`  | Rebuilds visit counts and preserves valid reviewed artifacts while history is reconciled.                                 |
| `src/function/engine/resume.ts`                  | Captures and compares run/session identity around asynchronous resume work so stale results cannot overwrite newer state. |
| `src/function/engine/advance-run.ts`             | Validates an ordinary outcome, appends step history, and moves to the next, completed, or paused state.                   |
| `src/function/engine/lifecycle-transitions.ts`   | Computes allowed outcomes and immutable pause, failure, resume, and abort transitions.                                    |
| `src/function/engine/reconciliation.ts`          | Reconciles a checkpoint with changed workflow digests and rewinds to the earliest affected step when required.            |
| `src/function/engine/run-validation.ts`          | Runtime type guard for persisted, untrusted workflow checkpoint values, including attempt and step usage aggregates.      |
| `src/function/engine/run-workflow-validation.ts` | Validates persisted control-flow, approvals, workspace binding, visits, and pending gates against the active workflow.    |
| `src/function/engine/step-trace.ts`              | Records and compacts bounded attempt tasks, results, gate decisions, main logs, usage, and child transcript references.   |
| `src/function/engine/transition-helpers.ts`      | Looks up the current step and applies timestamped run patches without mutation.                                           |
| `src/function/engine/usage.ts`                   | Normalizes Pi usage payloads, rejects malformed totals, and merges provider/model usage into durable aggregates.          |

## Parent Harness

`src/infrastructure/harness/harness.ts` owns the live references needed by Pi.
Each module below owns one cohesive operation family and exposes a factory for
composition. `src/harness.ts` re-exports that class from the root.

| Module                                                         | Responsibility                                                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/harness/action-context.ts`                 | Declares the complete state-and-operation shape shared by composed harness actions.                                                                                                             |
| `src/infrastructure/harness/catalog.ts`                        | Creates an empty catalog, formats diagnostics, and extracts available skill names from Pi events.                                                                                               |
| `src/infrastructure/harness/commands.ts`                       | Builds and registers slash commands against the small `WorkflowCommandController` port.                                                                                                         |
| `src/infrastructure/harness/context-idle.ts`                   | Waits for an event context to become idle without holding orchestration logic open.                                                                                                             |
| `src/infrastructure/harness/core-actions.ts`                   | Owns mutation serialization, checkpoint persistence/restore, catalog reload, preflight, tool isolation, and post-transition settling.                                                           |
| `src/infrastructure/harness/delegation-control-actions.ts`     | Cancels delegations, treats workspace cleanup as warning-only housekeeping, launches the single evidence-approved missing-completion retry, and pauses when recovery is unsafe or unavailable. |
| `src/infrastructure/harness/delegation-plan.ts`                | Builds each fresh child policy, private result workspace, correlated request, handoff task, budgets, and bounded automatic-recovery prompt with prior failures.                                 |
| `src/infrastructure/harness/delegation-recovery.ts`            | Normalizes terminal evidence, validates recovered completions, fingerprints failures, and decides whether a replay-safe fresh recovery attempt is allowed.                                      |
| `src/infrastructure/harness/delegation-response-actions.ts`    | Serializes progress and terminal responses, accepts proven recovered completions, advances runs, and performs best-effort cleanup before safe recovery or pause.                                |
| `src/infrastructure/harness/dependencies.ts`                   | Defines and supplies the effect ports for time, IDs, aborts, files, catalog loading, reviews, diagnostics, subagents, runtimes, queues, timers, and status UI.                                  |
| `src/infrastructure/harness/gate-submission-action.ts`         | Converts a gate submit outcome into persisted pending-review state and launches the selected review provider.                                                                                   |
| `src/infrastructure/harness/harness.ts`                        | Composes the `WorkflowHarness` class surface from action factories and live coordination state.                                                                                                 |
| `src/infrastructure/harness/lifecycle-actions.ts`              | Registers Pi lifecycle, tool-policy, and multiline command-input hooks.                                                                                                                         |
| `src/infrastructure/harness/pause-actions.ts`                  | Implements manual pause and abort, including active main-step, prompt-review, and delegation cleanup.                                                                                           |
| `src/infrastructure/harness/plannotator-result-actions.ts`     | Correlates asynchronous Plannotator results and applies or stores their gate resolution.                                                                                                        |
| `src/infrastructure/harness/prompt-gate-actions.ts`            | Launches, correlates, cancels, and applies built-in prompt review results.                                                                                                                      |
| `src/infrastructure/harness/resume-action.ts`                  | Reloads/reconciles configuration, validates the captured resume identity, restores gates, and relaunches the current step.                                                                      |
| `src/infrastructure/harness/session-persistence.ts`            | Forces an initial checkpoint to materialize in a session file and re-adopts that file for later appended entries.                                                                               |
| `src/infrastructure/harness/start-actions.ts`                  | Validates start requests, captures baseline tools, creates/checkpoints runs, and launches their first step.                                                                                     |
| `src/infrastructure/harness/status-actions.ts`                 | Builds snapshots, controls refresh timers and the shortcut, and opens the injected status view.                                                                                                 |
| `src/infrastructure/harness/step-effects.ts`                   | Validates declarative effects carried by step results, currently an immutable canonical workspace binding that its sole binding step may re-affirm.                                             |
| `src/infrastructure/harness/step-execution-actions.ts`         | Selects main versus delegated execution, activates main policy, contains synchronous subagent startup exceptions, and queues results.                                                           |
| `src/infrastructure/harness/step-reporting.ts`                 | Posts bounded visible step summaries, pause notices, and concise redacted failure messages after durable transitions.                                                                           |
| `src/infrastructure/harness/types.ts`                          | Shared live-coordination types for delegations, recovery blockers/history, main steps, reviews, and starts.                                                                                     |
| `src/infrastructure/harness/workflow-list.ts`                  | Pure Markdown formatting for the workflow catalog list command.                                                                                                                                |
| `src/infrastructure/harness/workspace-directory.ts`            | Canonicalizes and confines structured workspace results to existing directories under YAML-authorized relative roots.                                                                           |
