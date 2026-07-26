# Execution Modules

This page maps the adapters and runtime modules that execute a configured
workflow step. See
[Orchestration Modules](./orchestration-modules.md) for loading, state
transitions, and parent-mode coordination.

## Review Integrations

| Module                                      | Responsibility                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/integrations/plannotator.ts`           | Stable facade for Plannotator requests, response normalization, result parsing, and types. |
| `src/integrations/plannotator-requests.ts`  | Publishes start/status events and makes timeout scheduling injectable.                     |
| `src/integrations/plannotator-responses.ts` | Normalizes unknown event replies and validates review-result payloads.                     |
| `src/integrations/plannotator-types.ts`     | Event-bus port and normalized Plannotator request/status/result types.                     |
| `src/integrations/prompt-gate.ts`           | Runs the built-in review selector and feedback editor with abort-aware UI dependencies.    |

## Subagent Integration

The public surfaces are `client.ts`, `protocol.ts`, `diagnostics.ts`, and
`child-runtime.ts`. Their sibling modules isolate protocol, file, policy, and
diagnostic concerns.

| Module                                                     | Responsibility                                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/integrations/subagents/protocol-events.ts`            | Versioned parent-child event names and upstream request/update/response aliases.                                               |
| `src/integrations/subagents/protocol.ts`                   | Stable protocol facade for child policies, delegated results, events, and public types.                                        |
| `src/integrations/subagents/client-types.ts`               | Event-bus, request option, dependency, timer, and active-delegation controller types.                                          |
| `src/integrations/subagents/client-messages.ts`            | Guards status/version/request fields and rejects malformed subagent updates or terminal responses.                             |
| `src/integrations/subagents/client-delegation.ts`          | Creates one correlated delegation, subscribes to events, enforces timeout/cancellation, and releases listeners.                |
| `src/integrations/subagents/client.ts`                     | Functional client factory plus compatibility class for one active delegation at a time.                                        |
| `src/integrations/subagents/delegated-result.ts`           | Adds policy correlation fields and validates delegated structured results through the shared step-result parser.               |
| `src/integrations/subagents/child-policy-types.ts`         | Child policy envelope and extracted-policy types.                                                                              |
| `src/integrations/subagents/child-policy-envelope.ts`      | Encodes a policy into the child task and extracts one nonduplicated envelope.                                                  |
| `src/integrations/subagents/child-policy-sections.ts`      | Parses policy sections and JSON payloads before semantic validation.                                                           |
| `src/integrations/subagents/child-policy-validation.ts`    | Validates runtime identity, policy fields, outcomes, permissions, and request correlation.                                     |
| `src/integrations/subagents/child-policy-paths.ts`         | Validates private capability/result paths against the temporary-directory boundary.                                            |
| `src/integrations/subagents/child-runtime-types.ts`        | Injected filesystem and child-runtime dependency ports.                                                                        |
| `src/integrations/subagents/child-runtime-dependencies.ts` | Supplies the Node-backed child dependency defaults.                                                                            |
| `src/integrations/subagents/child-runtime-policy.ts`       | Projects child policy into a workflow step and renders the child system policy.                                                |
| `src/integrations/subagents/child-runtime-files.ts`        | Atomically verifies and consumes capabilities, then writes bounded correlated results.                                         |
| `src/integrations/subagents/child-runtime-completion.ts`   | Defines `structured_output`, blocks coordination tools, and parses the child's completion call.                                |
| `src/integrations/subagents/child-runtime.ts`              | Registers child hooks, activates allowed tools, enforces policy, and coordinates completion/result writing.                    |
| `src/integrations/subagents/diagnostic-types.ts`           | Transcript, tool failure, replay audit, session identity, and filesystem diagnostic types.                                     |
| `src/integrations/subagents/diagnostic-text.ts`            | Bounds and extracts comparable text, tool calls, and structured completion values from unknown transcript records.             |
| `src/integrations/subagents/diagnostic-format.ts`          | Extracts failed tool names and renders concise failure evidence.                                                               |
| `src/integrations/subagents/failure-transcript.ts`         | Parses calls, results, completions, messages, ordering, and proof completeness from a child JSONL transcript.                  |
| `src/integrations/subagents/failure-correlation.ts`        | Correlates terminal errors to transcript failures or a proven hidden Bash false positive and detects completion after failure. |
| `src/integrations/subagents/hidden-bash-failure.ts`        | Reproduces the narrow upstream Bash false-positive projection from successful transcript evidence.                             |
| `src/integrations/subagents/replay-safety.ts`              | Classifies actual transcript calls as known-safe, rejected before execution, or unknown-effect before automatic recovery.      |
| `src/integrations/subagents/replay-audit.ts`               | Verifies complete transcript structure, original task binding, tool counts, and mutation-safe actual calls.                    |
| `src/integrations/subagents/session-diagnostics.ts`        | Constrains trusted session paths and reads bounded transcript tails for failure and replay analysis.                           |
| `src/integrations/subagents/diagnostics.ts`                | Stable facade for diagnostic readers, parsers, formatters, and types.                                                          |

## Policy Core

Policy functions return allow/reject decisions. Pi hook registration stays in
the runtime modules.

| Module                                  | Responsibility                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/policy/tool-types.ts`              | Inventory, source metadata, and authorization result types.                                                       |
| `src/policy/tool-selection.ts`          | Matches extension selectors, computes active tools, and recognizes allowed extension tools.                       |
| `src/policy/tool-call-authorization.ts` | Dispatches a tool call to core, extension, MCP, and Bash authorization rules.                                     |
| `src/policy/mcp-authorization.ts`       | Checks MCP proxy server/tool selectors and rejects unsupported proxy input shapes.                                |
| `src/policy/tools.ts`                   | Stable facade for tool selection, authorization, and public types.                                                |
| `src/policy/bash-types.ts`              | Bash authorization decision and restricted token types.                                                           |
| `src/policy/restricted-command.ts`      | Tokenizes the deliberately small shell grammar and rejects operators, expansion, wrappers, and malformed quoting. |
| `src/policy/bash-authorization.ts`      | Applies deny, generic allow-list, and unrestricted Bash policy.                                                   |
| `src/policy/bash.ts`                    | Stable facade for Bash authorization and restricted parsers.                                                      |
| `src/policy/completion-batch.ts`        | Rejects completion tool calls that share a model turn with unrelated tool calls.                                  |
| `src/policy/immutable-input.ts`         | Deep-clones and freezes tool inputs before asynchronous policy checks use them.                                   |

## Prompt Core

| Module                               | Responsibility                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/prompt/main-workflow-notice.ts` | Builds the parent-agent notice while a main-mode workflow step owns the turn.                                                 |
| `src/prompt/retry-task.ts`           | Produces an escaped automatic-recovery prompt containing all prior distinct failure evidence and the remaining attempt count. |
| `src/prompt/step-contract.ts`        | Derives outcome/completion/recovery constraints from the workflow, run, and step.                                             |
| `src/prompt/step-sections.ts`        | Renders required resources, explicit handoff, and delegated completion instructions.                                          |
| `src/prompt/step-task.ts`            | Composes common, main, and delegated step tasks from prompt text, templates, contracts, and sections.                         |
| `src/prompt/template.ts`             | Builds template values and renders supported workflow placeholders.                                                           |

## Main-Step Runtime

| Module                                   | Responsibility                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/runtime/completion-tool.ts`         | Declares the main `workflow_complete_step` tool and its TypeBox input schema.                        |
| `src/runtime/main-step-runtime-types.ts` | Execution, controller, state, and injected dependency types.                                         |
| `src/runtime/main-step-state.ts`         | Pure activation, deactivation, and settlement changes for runtime state.                             |
| `src/runtime/main-step-policy.ts`        | Registers tool-call hooks and enforces the active step policy.                                       |
| `src/runtime/main-step-completion.ts`    | Registers the completion tool, validates request identity/result shape, and stores accepted results. |
| `src/runtime/main-step-lifecycle.ts`     | Resolves or rejects pending completion when the Pi agent settles.                                    |
| `src/runtime/main-step-runtime.ts`       | Composes the functional controller and preserves the compatibility `MainStepRuntime` class.          |
| `src/runtime/serial-task-queue.ts`       | Serializes asynchronous state mutations; exposes a factory and compatibility class.                  |
| `src/runtime/step-result.ts`             | Validates allowed outcome, summary/artifact bounds, and gate artifact requirements.                  |

## Workflow Status

| Module                                      | Responsibility                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/workflow-status/types.ts`              | Snapshot, execution, theme, path, and view port types.                                                      |
| `src/workflow-status/formatting.ts`         | Status glyphs, colors, labels, titles, timestamps, elapsed time, and inline text helpers.                   |
| `src/workflow-status/layout.ts`             | ANSI-aware row clamping, boxes, panels, columns, and padding.                                               |
| `src/workflow-status/render-path.ts`        | Converts run history/current state into path entries and rendered path lines.                               |
| `src/workflow-status/render-summary.ts`     | Renders header and detailed summary lines from a status snapshot.                                           |
| `src/workflow-status/render-board.ts`       | Chooses wide/narrow layouts and renders populated or empty boards.                                          |
| `src/workflow-status/render-step-detail.ts` | Resolves a selected path entry and renders persisted tasks, results, gate decisions, and transcript events. |
| `src/workflow-status/transcript-reader.ts`  | Confines, stably reads, bounds, sanitizes, and redacts common credential forms in child events on demand.   |
| `src/workflow-status/format-status.ts`      | Public text/board formatting entry points.                                                                  |
| `src/workflow-status/view.ts`               | Interactive board/detail navigation, transcript loading/cache, refresh scheduling, and overlay boundary.    |
