# Execution Modules

This page maps the adapters and runtime modules that execute a configured
workflow step. See
[Orchestration Modules](./orchestration-modules.md) for loading, state
transitions, and parent-mode coordination.

## Review Integrations

| Module                                                | Responsibility                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/domain/plannotator.ts`                           | Event-bus port and normalized Plannotator request/status/result types.                     |
| `src/infrastructure/integrations/plannotator.ts`      | Stable facade for Plannotator requests, response normalization, result parsing, and types. |
| `src/infrastructure/integrations/plannotator-requests.ts`  | Publishes start/status events and makes timeout scheduling injectable.                     |
| `src/infrastructure/integrations/plannotator-responses.ts` | Normalizes unknown event replies and validates review-result payloads.                     |
| `src/infrastructure/integrations/prompt-gate.ts`      | Runs the built-in review selector and feedback editor with abort-aware UI dependencies.    |

## Subagent Integration

Parent-side process transport lives in `src/infrastructure/process/`, child
runtime files live in `src/infrastructure/runtime/`, and pure policy/result
validation lives in `src/function/subagent/`.

| Module                                                  | Responsibility                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/domain/subagent.ts`                                | Delegation request/update/response, child policy, and protocol event types.                                                    |
| `src/function/subagent/delegated-result.ts`             | Adds policy correlation fields and validates delegated structured results through the shared step-result parser.               |
| `src/function/subagent/child-policy-envelope.ts`        | Encodes a policy into the child task and extracts one nonduplicated envelope.                                                  |
| `src/function/subagent/child-policy-sections.ts`        | Parses policy sections and JSON payloads before semantic validation.                                                           |
| `src/function/subagent/child-policy-validation.ts`      | Validates runtime identity, policy fields, outcomes, permissions, and request correlation.                                     |
| `src/function/subagent/child-policy-paths.ts`           | Validates private capability/result paths against the temporary-directory boundary.                                            |
| `src/function/subagent/diagnostics.ts`                  | Constrains trusted session paths, reads bounded transcript tails, parses calls/results/completions, renders concise evidence, and audits replay safety. |
| `src/infrastructure/process/subagent-client.ts`         | Functional client factory plus compatibility class for one active delegation at a time, including message validation, timeout, cancellation, and listener cleanup. |
| `src/infrastructure/fs/subagent-files.ts`               | Atomically verifies and consumes capabilities, then writes bounded correlated results.                                         |
| `src/infrastructure/runtime/child-runtime-types.ts`     | Injected filesystem and child-runtime dependency ports.                                                                        |
| `src/infrastructure/runtime/child-runtime-dependencies.ts` | Supplies the Node-backed child dependency defaults.                                                                            |
| `src/infrastructure/runtime/child-runtime-policy.ts`    | Projects child policy into a workflow step and renders the child system policy.                                                |
| `src/infrastructure/runtime/child-runtime-completion.ts` | Defines `structured_output`, blocks coordination tools, and parses the child's completion call.                                |
| `src/infrastructure/runtime/child-runtime-repair.ts`    | Issues the one same-session completion-only repair follow-up and tool-budget handoff prompts when a child must settle without more work tools. |
| `src/infrastructure/runtime/child-runtime.ts`           | Registers child hooks, activates allowed tools, enforces policy, and coordinates completion/result writing.                    |

## Policy Core

Policy functions return allow/reject decisions. Pi hook registration stays in
the runtime modules.

| Module                                      | Responsibility                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/domain/policy.ts`                      | Inventory, source metadata, Bash authorization decision, restricted token, and authorization result types.         |
| `src/function/policy/tool-selection.ts`     | Matches extension selectors, computes active tools, and recognizes allowed extension tools.                       |
| `src/function/policy/tool-auth.ts`          | Dispatches a tool call to core, extension, MCP, and Bash authorization rules.                                     |
| `src/function/policy/mcp-authorization.ts`  | Checks MCP proxy server/tool selectors and rejects unsupported proxy input shapes.                                |
| `src/function/policy/tools.ts`              | Stable facade for tool selection, authorization, and public types.                                                |
| `src/function/policy/restricted-command.ts` | Tokenizes the deliberately small shell grammar and rejects operators, expansion, wrappers, and malformed quoting. |
| `src/function/policy/bash-auth.ts`          | Applies deny, generic allow-list, and unrestricted Bash policy.                                                   |
| `src/function/policy/bash.ts`               | Stable facade for Bash authorization and restricted parsers.                                                      |
| `src/function/policy/completion-batch.ts`   | Rejects completion tool calls that share a model turn with unrelated tool calls.                                  |
| `src/function/policy/immutable-input.ts`    | Deep-clones and freezes tool inputs before asynchronous policy checks use them.                                   |

## Prompt Core

| Module                                        | Responsibility                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/function/prompt/main-workflow-notice.ts` | Builds the parent-agent notice while a main-mode workflow step owns the turn.                                                 |
| `src/function/prompt/retry-task.ts`           | Produces an escaped automatic-recovery prompt containing all prior distinct failure evidence and the remaining attempt count. |
| `src/function/prompt/step-contract.ts`        | Derives outcome/completion/recovery constraints from the workflow, run, and step.                                             |
| `src/function/prompt/step-sections.ts`        | Renders required resources, explicit handoff, and delegated completion instructions.                                          |
| `src/function/prompt/step-task.ts`            | Composes common, main, and delegated step tasks from prompt text, templates, contracts, and sections.                         |
| `src/function/prompt/template.ts`             | Builds template values and renders supported workflow placeholders.                                                           |

## Main-Step Runtime

| Module                                                | Responsibility                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/infrastructure/runtime/completion-tool.ts`       | Declares the main `workflow_complete_step` tool and its TypeBox input schema.                        |
| `src/infrastructure/runtime/main-step-runtime-types.ts` | Execution, controller, state, and injected dependency types.                                         |
| `src/infrastructure/runtime/main-step-state.ts`       | Pure activation, deactivation, and settlement changes for runtime state.                             |
| `src/infrastructure/runtime/main-step-policy.ts`      | Registers tool-call hooks and enforces the active step policy.                                       |
| `src/infrastructure/runtime/main-step-completion.ts`  | Registers the completion tool, validates request identity/result shape, and stores accepted results. |
| `src/infrastructure/runtime/main-step-lifecycle.ts`   | Resolves or rejects pending completion when the Pi agent settles.                                    |
| `src/infrastructure/runtime/main-step-trace.ts`       | Captures a redacted, size-bounded prefix of finalized main-agent assistant/tool events and usage.    |
| `src/infrastructure/runtime/main-step-runtime.ts`     | Composes the functional controller and preserves the compatibility `MainStepRuntime` class.          |
| `src/infrastructure/runtime/task-queue.ts`            | Serializes asynchronous state mutations; exposes a factory and compatibility class.                  |
| `src/function/step-result/parse-result.ts`            | Validates allowed outcome, summary/artifact bounds, and gate artifact requirements.                  |
| `src/function/step-result/validate-contract.ts`       | Validates step artifact contracts for workflow authoring.                                            |

## Workflow Status

| Module                              | Responsibility                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/domain/status.ts`              | Snapshot, execution, theme, path, and view port types.                                                      |
| `src/ui/format-usage.ts`            | Aggregates workflow usage and formats cost and token totals.                                                |
| `src/ui/formatting.ts`              | Status glyphs, colors, labels, titles, timestamps, elapsed time, and inline text helpers.                   |
| `src/ui/layout.ts`                  | ANSI-aware row clamping, boxes, panels, columns, and padding.                                               |
| `src/ui/render-path.ts`             | Converts run history/current state into path entries and rendered path lines with per-step costs.           |
| `src/ui/render-summary.ts`          | Renders header and detailed summary lines, including workflow-level usage, from a status snapshot.          |
| `src/ui/render-board.ts`            | Chooses wide/narrow layouts and renders populated or empty boards.                                          |
| `src/ui/render-step-detail.ts`      | Resolves a selected path entry and renders persisted tasks, usage, results, gate decisions, and transcript events. |
| `src/infrastructure/fs/transcript-reader.ts` | Confines, stably reads, bounds, sanitizes, and redacts common credential forms in child events on demand.   |
| `src/ui/format-status.ts`           | Public text/board formatting entry points for progress, status text, and usage.                            |
| `src/ui/view.ts`                    | Interactive board/detail/live navigation, transcript loading/cache, refresh scheduling, and overlay boundary. |
