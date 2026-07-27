# Orchestration Modules

This page maps the modules that load workflows, evolve persisted state, and
coordinate parent-mode execution. See
[Execution Modules](./execution-modules.md) for integrations, policy, prompts,
step runtimes, and status rendering.

## Composition Pattern

The refactor separates three kinds of modules:

- **Facades** preserve established import paths while re-exporting focused
  implementations.
- **Functional cores** calculate validation, transition, and formatting results
  without owning external state.
- **Action factories** return operations that are bound to a narrow harness
  context. `WorkflowHarness` composes those operations and injects external
  effects through `WorkflowHarnessDependencies`.

## Root Modules

| Module                   | Responsibility                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/command-names.ts`   | Defines workflow, Pi built-in, and reserved command names used by conflict validation.                                                               |
| `src/commands.ts`        | Builds and registers slash commands against the small `WorkflowCommandController` port.                                                              |
| `src/digest.ts`          | Canonicalizes values and hashes workflow state; `createDigest` makes the hash implementation injectable.                                             |
| `src/harness.ts`         | Compatibility class and composition root for parent-mode action modules. It stores live coordination state but delegates behavior to `src/harness/`. |
| `src/index.ts`           | Extension entry and factory. It chooses parent or child mode and injects environment, settings, harness, and child-runtime constructors.             |
| `src/preflight.ts`       | Uses tool and skill inventories to report missing tools, extensions, skills, MCP support, Plannotator, or pi-subagents before execution.             |
| `src/prompt.ts`          | Facade for the focused prompt-building modules.                                                                                                      |
| `src/workflow-doctor.ts` | Analyzes workflow transition graphs for completion paths, trapped reachable steps, unreachable steps, and cycles.                                    |
| `src/workflow-list.ts`   | Pure Markdown formatting for the workflow catalog command.                                                                                           |
| `src/workflow-status.ts` | Facade for status formatters, renderers, types, and the interactive view.                                                                            |

## Configuration

| Module                            | Responsibility                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/catalog.ts`           | Composes the injected settings/workflow loaders, project trust checks, permission ceilings, conflict checks, and final catalog diagnostics. |
| `src/config/ceiling.ts`           | Proves that project-workflow permissions and subagent budgets stay within the configured ceiling.                                           |
| `src/config/command-conflicts.ts` | Detects exact and suffixed runtime command collisions.                                                                                      |
| `src/config/diagnostics.ts`       | Normalizes loader errors into stable diagnostic messages and codes.                                                                         |
| `src/config/load-settings.ts`     | Reads, parses, and validates `settings.yaml`.                                                                                               |
| `src/config/load-types.ts`        | Defines filesystem, environment, loader, and intermediate-result ports used by configuration DI.                                            |
| `src/config/load-workflows.ts`    | Enumerates a workflow directory, constrains prompt paths to that directory, validates YAML, loads prompts, and computes digests.            |
| `src/config/load.ts`              | Node-backed compatibility facade and default `loadCatalog`/`loadSettings` functions.                                                        |
| `src/config/step-digests.ts`      | Computes per-step digests with prompt text and structural digests without prompt text for reconciliation and approval provenance.           |
| `src/config/types.ts`             | Canonical configuration constants and types, including workflows, steps, gates, permissions, subagents, settings, and diagnostics.          |
| `src/config/validate.ts`          | Compatibility facade for validators plus a mutable requirements clone for parser assembly.                                                  |
| `src/config/yaml.ts`              | Parses YAML and turns parser failures into document-specific errors.                                                                        |

### Configuration Validation

| Module                                 | Responsibility                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/validation/shared.ts`      | Shared patterns, JSON-object guards, unknown-key rejection, primitive readers, and validation result types.                             |
| `src/config/validation/settings.ts`    | Validates settings, project-workflow controls, permission ceilings, and defaults.                                                       |
| `src/config/validation/workflow.ts`    | Validates the workflow document, assembles steps, checks the transition graph, and returns a normalized definition.                     |
| `src/config/validation/step.ts`        | Parses one step's prompt, transitions, gate, permissions, requirements, and optional subagent.                                          |
| `src/config/validation/subagent.ts`    | Parses subagent identity, timeout, model, artifacts, broad automatic-recovery permission, and turn/tool budgets for steps and ceilings. |
| `src/config/validation/permissions.ts` | Parses tool, extension, MCP, skill, and Bash permissions and requirements.                                                              |
| `src/config/validation/prompt.ts`      | Rejects unsupported prompt template variables.                                                                                          |
| `src/config/validation/shortcut.ts`    | Canonicalizes and validates the status keyboard shortcut.                                                                               |

## State Engine

All engine transitions return new run values; they do not perform Pi, file, UI,
timer, or subagent effects.

| Module                                  | Responsibility                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/checkpoint.ts`              | Finds and validates the newest workflow checkpoint in session entries.                                                    |
| `src/engine/create-run.ts`              | Creates the first immutable run state from a loaded workflow and baseline tools.                                          |
| `src/engine/gate-transitions.ts`        | Begins review, attaches review IDs, records review failures/resolutions, and applies approved or rejected outcomes.       |
| `src/engine/reconciliation-history.ts`  | Rebuilds visit counts and preserves valid reviewed artifacts while history is reconciled.                                 |
| `src/engine/resume.ts`                  | Captures and compares run/session identity around asynchronous resume work so stale results cannot overwrite newer state. |
| `src/engine/run-advance.ts`             | Validates an ordinary outcome, appends step history, and moves to the next, completed, or paused state.                   |
| `src/engine/run-lifecycle.ts`           | Computes allowed outcomes and immutable pause, failure, resume, and abort transitions.                                    |
| `src/engine/run-reconciliation.ts`      | Reconciles a checkpoint with changed workflow digests and rewinds to the earliest affected step when required.            |
| `src/engine/run-validation.ts`          | Runtime type guard for persisted, untrusted workflow checkpoint values.                                                   |
| `src/engine/run-workflow-validation.ts` | Validates persisted control-flow, approvals, workspace binding, visits, and pending gates against the active workflow.    |
| `src/engine/state-types.ts`             | Versioned run, history, gate, status, workspace, and step-trace types.                                                    |
| `src/engine/state.ts`                   | Compatibility facade for state creation, validation, constants, and types.                                                |
| `src/engine/step-trace.ts`              | Records and compacts bounded attempt tasks, results, gate decisions, main logs, and child transcript references.          |
| `src/engine/transition-helpers.ts`      | Looks up the current step and applies timestamped run patches without mutation.                                           |
| `src/engine/transition-types.ts`        | Result type for configuration reconciliation.                                                                             |
| `src/engine/transitions.ts`             | Compatibility facade for run, gate, lifecycle, and reconciliation transitions.                                            |

## Parent Harness

`src/harness.ts` owns the live references needed by Pi. Each module below owns
one cohesive operation family and exposes a factory for composition.

| Module                                          | Responsibility                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/action-context.ts`                 | Declares the complete state-and-operation shape shared by composed harness actions.                                                                                                             |
| `src/harness/catalog.ts`                        | Creates an empty catalog, formats diagnostics, and extracts available skill names from Pi events.                                                                                               |
| `src/harness/context-idle.ts`                   | Waits for an event context to become idle without holding orchestration logic open.                                                                                                             |
| `src/harness/core-actions.ts`                   | Owns mutation serialization, checkpoint persistence/restore, catalog reload, preflight, tool isolation, and post-transition settling.                                                           |
| `src/harness/delegation-control-actions.ts`     | Cancels delegations, treats workspace cleanup as warning-only housekeeping, launches up to two evidence-approved recovery attempts, and pauses when recovery is unsafe, repeated, or exhausted. |
| `src/harness/delegation-failure.ts`             | Normalizes terminal evidence, marks cancellation/interruption/detach/stop/inconsistent-timeout/reported-mutation blockers, and composes injected transcript diagnostics.                        |
| `src/harness/delegation-plan.ts`                | Builds each fresh child policy, private result workspace, correlated request, handoff task, budgets, and bounded automatic-recovery prompt with prior failures.                                 |
| `src/harness/delegation-recovery-validation.ts` | Proves that a failed terminal projection, trusted transcript completion, and correlated result artifact agree exactly.                                                                          |
| `src/harness/delegation-response-actions.ts`    | Serializes progress and terminal responses, accepts proven recovered completions, advances runs, and performs best-effort cleanup before safe recovery or pause.                                |
| `src/harness/delegation-retry-policy.ts`        | Fingerprints semantic failures, recognizes recoverable terminal statuses, bounds evidence, and requires a complete mutation-safe actual-call audit.                                             |
| `src/harness/dependencies.ts`                   | Defines and supplies the effect ports for time, IDs, aborts, files, catalog loading, reviews, diagnostics, subagents, runtimes, queues, timers, and status UI.                                  |
| `src/harness/gate-submission-action.ts`         | Converts a gate submit outcome into persisted pending-review state and launches the selected review provider.                                                                                   |
| `src/harness/lifecycle-actions.ts`              | Registers Pi lifecycle, tool-policy, and multiline command-input hooks.                                                                                                                         |
| `src/harness/pause-actions.ts`                  | Implements manual pause and abort, including active main-step, prompt-review, and delegation cleanup.                                                                                           |
| `src/harness/plannotator-result-actions.ts`     | Correlates asynchronous Plannotator results and applies or stores their gate resolution.                                                                                                        |
| `src/harness/prompt-gate-actions.ts`            | Launches, correlates, cancels, and applies built-in prompt review results.                                                                                                                      |
| `src/harness/resume-action.ts`                  | Reloads/reconciles configuration, validates the captured resume identity, restores gates, and relaunches the current step.                                                                      |
| `src/harness/start-actions.ts`                  | Validates start requests, captures baseline tools, creates/checkpoints runs, and launches their first step.                                                                                     |
| `src/harness/status-actions.ts`                 | Builds snapshots, controls refresh timers and the shortcut, and opens the injected status view.                                                                                                 |
| `src/harness/step-effects.ts`                   | Validates declarative effects carried by step results, currently an immutable canonical workspace binding that its sole binding step may re-affirm.                                             |
| `src/harness/step-execution-actions.ts`         | Selects main versus delegated execution, activates main policy, contains synchronous subagent startup exceptions, and queues results.                                                           |
| `src/harness/step-reporting.ts`                 | Posts bounded visible step summaries, pause notices, and concise redacted failure messages after durable transitions.                                                                           |
| `src/harness/types.ts`                          | Shared live-coordination types for delegations, recovery blockers/history, main steps, reviews, and starts.                                                                                     |
| `src/harness/workspace-directory.ts`            | Canonicalizes and confines structured workspace results to existing directories under YAML-authorized relative roots.                                                                           |
