# Delegated Completion Repair

## Goal

Prevent every delegated workflow from pausing solely because a child finishes work but omits its required correlated `structured_output` result. Preserve exact result validation and never replay possibly-mutating work.

## Scope

- Applies centrally to every delegated child step, including `/work` planning and `sprint-triage` publication.
- Does not change workflow YAML outcome semantics, permissions, or accepted result schema.
- Does not infer an outcome from final prose.

## Design

### Same-child completion repair

The child runtime tracks whether its validated correlated result file has been written. On Pi `agent_settled`, if a policy is active, no result exists, and no repair has already been requested, it queues one follow-up message in the same child session.

The follow-up is deterministic: do not repeat or execute work tools; inspect prior completed work only as already present in context; call `structured_output` exactly once and alone with one configured outcome, compact factual summary, and required artifact/workspace fields. The runtime limits this to one repair turn per delegated policy.

Same-child repair retains the original context and observed side effects. It therefore avoids re-running a push, merge-request creation, Confluence update, Bash command, edit, or write merely to obtain the missing completion record.

### Parent fallback and diagnostics

The parent still accepts a delegated step only by reading `result.json` and validating its policy digest, schema, outcome, and workspace binding. If the repair turn also exits without a result, the parent pauses; it never manufactures a result from assistant prose or JSONL events.

The direct worker client retains a bounded, redacted transcript of child terminal/progress events and returns its trusted location or terminal summary. The paused reason names the request ID, exit status, result-file state, repair-attempt state, and bounded diagnostic evidence.

### Fresh recovery

A fresh child retry is considered only after same-child repair fails and diagnostics prove the original attempt was read-only. Any executed `bash`, `edit`, `write`, mutation-capable MCP action, unknown call, malformed transcript, or missing transcript blocks fresh recovery and pauses instead. Recovery is bounded and receives explicit no-blind-replay instructions.

## Error handling

- Policy/capability/result-file failures remain terminal and diagnostic.
- A completed child with a valid result bypasses repair.
- A child with an invalid `structured_output` call remains active for its normal correction turn; repair triggers only after settlement and only once.
- Failure to queue a repair follow-up is surfaced as a paused execution failure with the underlying error.

## Tests

1. A read-only child that settles without completion receives one same-child repair turn and accepts its later valid correlated result.
2. A second settled omission after repair pauses; no loop or fabricated outcome.
3. A mutating child receives same-child repair, not a fresh retry.
4. Only a proven read-only failed repair can launch one fresh child recovery.
5. Unknown, malformed, absent, or mutation-capable evidence never launches fresh recovery.
6. Existing valid completion, policy validation, workspace binding, direct-worker client, and direct-worker E2E tests remain green.

## Risks

`agent_settled` behavior is Pi-version-dependent. Tests will use the installed Pi 0.84.2 lifecycle contract and assert that the repair follow-up is queued exactly once. A model or runtime that cannot call the completion tool after repair remains safely paused with correlated diagnostics.
