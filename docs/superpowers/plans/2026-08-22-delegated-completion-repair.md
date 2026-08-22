# Delegated Completion Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair one omitted delegated `structured_output` call in the original child session, then safely diagnose or recover all delegated workflow steps without replaying mutations.

**Architecture:** The child runtime owns the primary same-session repair, using Pi 0.84.2 `agent_settled` and a one-shot injected follow-up. The parent remains the sole result acceptor. The direct-worker client records bounded redacted terminal evidence, while a recovery classifier permits one fresh retry only after a failed repair with proven read-only calls.

**Tech Stack:** TypeScript, Bun test runner, Pi extension lifecycle API 0.84.2, Node child processes and filesystem.

**Spec:** `docs/superpowers/specs/2026-08-22-delegated-completion-repair-design.md`

## Global Constraints

- Accept a delegated result only from `result.json` after existing policy-digest, schema, outcome, and workspace validation.
- Never derive an outcome from assistant prose or JSONL output.
- Queue at most one same-child repair follow-up per delegated policy; the follow-up must forbid work tools and require one isolated `structured_output` call.
- Never launch fresh recovery after an executed `bash`, `edit`, `write`, mutation-capable MCP call, unknown call, malformed evidence, or absent evidence.
- Preserve existing workflow YAML semantics, tool permissions, and valid-result behavior.
- Target the installed Pi lifecycle contract: `agent_settled` runs only after queued continuations, retries, and compaction retries have settled.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/integrations/subagents/child-runtime-repair.ts` | One-shot same-child repair state, message, and settled lifecycle handler. |
| `src/integrations/subagents/child-runtime.ts` | Wire repaired lifecycle state into active policy/result handling. |
| `src/integrations/subagents/client.ts` | Capture bounded redacted JSONL event evidence and expose it on terminal response. |
| `src/integrations/subagents/diagnostics.ts` | Parse terminal evidence and classify calls as read-only, unsafe, or incomplete. |
| `src/integrations/subagents/protocol-events.ts` | Add typed optional terminal diagnostic payload to delegated responses. |
| `src/harness/delegation-response-actions.ts` | Use diagnostics to choose a bounded fresh recovery or detailed safe pause. |
| `src/harness/delegation-recovery.ts` | Build/limit a fresh recovery delegation without duplicating run state. |
| `test/subagent-child-runtime.test.ts` | Child repair lifecycle contract. |
| `test/direct-worker-client.test.ts` | Terminal evidence capture/redaction contract. |
| `test/delegation-recovery.test.ts` | Parent classifier and recovery/pause behavior. |
| `test/e2e/direct-worker-runtime.test.ts` | End-to-end repair turn and unchanged successful-step coverage. |

### Task 1: Same-child completion repair

**Files:**
- Create: `src/integrations/subagents/child-runtime-repair.ts`
- Modify: `src/integrations/subagents/child-runtime.ts`
- Test: `test/subagent-child-runtime.test.ts`

**Interfaces:**
- Consumes: active `ChildStepPolicy`, `resultPath`, Pi `agent_settled`, and `pi.sendUserMessage(content, { deliverAs: 'followUp' })`.
- Produces: `requestCompletionRepair({ pi, state }): void`; it queues one follow-up only when a policy is active, `result.json` is absent, and no repair was queued.

- [ ] **Step 1: Write failing child repair tests**

```ts
test('queues one isolated completion repair after a settled child omits its result', () => {
  activate(policy);
  handlers.get('agent_settled')!({}, context);
  expect(sentUserMessages).toEqual([
    expect.objectContaining({ content: expect.stringContaining('Do not execute work tools') }),
  ]);
  handlers.get('agent_settled')!({}, context);
  expect(sentUserMessages).toHaveLength(1);
});

test('does not repair after a valid correlated result exists', () => {
  activate(policy);
  completeValidResult(policy);
  handlers.get('agent_settled')!({}, context);
  expect(sentUserMessages).toEqual([]);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `bun test test/subagent-child-runtime.test.ts`

Expected: FAIL because no `agent_settled` handler queues a repair follow-up.

- [ ] **Step 3: Implement the one-shot repair helper**

```ts
export const COMPLETION_REPAIR_PROMPT = [
  'The delegated step settled without its required correlated result.',
  'Do not repeat completed work and do not execute work tools.',
  'Call `structured_output` exactly once, alone, with one configured outcome.',
].join('\n');

export function requestCompletionRepair({ pi, state }: RepairOptions): void {
  if (!state.activePolicy || state.repairRequested || resultExists(state.activePolicy)) return;
  state.repairRequested = true;
  pi.sendUserMessage(COMPLETION_REPAIR_PROMPT, { deliverAs: 'followUp' });
}
```

Add `repairRequested: boolean` to child runtime state; reset it only when a newly extracted policy is accepted. Register the helper from `agent_settled`. Keep all ordinary tools unavailable for the repair turn except `structured_output` by temporarily narrowing active tools before queueing the follow-up.

- [ ] **Step 4: Run focused child-runtime tests and verify green**

Run: `bun test test/subagent-child-runtime.test.ts`

Expected: PASS, including valid completion, blocked mixed calls, and one-shot repair tests.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/subagents/child-runtime-repair.ts src/integrations/subagents/child-runtime.ts test/subagent-child-runtime.test.ts
git commit -m "fix: repair missing delegated completion"
```

### Task 2: Bounded terminal evidence

**Files:**
- Modify: `src/integrations/subagents/protocol-events.ts`
- Modify: `src/integrations/subagents/client.ts`
- Create: `src/integrations/subagents/diagnostics.ts`
- Test: `test/direct-worker-client.test.ts`
- Test: `test/delegation-recovery.test.ts`

**Interfaces:**
- Consumes: Pi JSONL `tool_execution_start`, `tool_execution_end`, `agent_settled`, and process exit event lines.
- Produces: `DelegationDiagnostic { readonly events: readonly DiagnosticEvent[]; readonly complete: boolean }` and `classifyRecoverySafety(diagnostic): 'read-only' | 'unsafe' | 'incomplete'`.

- [ ] **Step 1: Write failing diagnostics tests**

```ts
test('classifies read-only events as eligible only after repair failed', () => {
  expect(classifyRecoverySafety(readOnlyDiagnostic)).toBe('read-only');
});

test.each(['bash', 'edit', 'write', 'mcp'])('classifies %s as unsafe', (toolName) => {
  expect(classifyRecoverySafety(diagnosticWithExecuted(toolName))).toBe('unsafe');
});

test('classifies malformed or truncated terminal evidence as incomplete', () => {
  expect(classifyRecoverySafety({ events: [], complete: false })).toBe('incomplete');
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `bun test test/direct-worker-client.test.ts test/delegation-recovery.test.ts`

Expected: FAIL because no diagnostic type, parser, or classifier exists.

- [ ] **Step 3: Implement redacted bounded evidence and classifier**

```ts
export type RecoverySafety = 'read-only' | 'unsafe' | 'incomplete';

export function classifyRecoverySafety(diagnostic: DelegationDiagnostic): RecoverySafety {
  if (!diagnostic.complete) return 'incomplete';
  if (diagnostic.events.some((event) => event.kind !== 'tool' || event.mutationCapable)) return 'unsafe';
  return 'read-only';
}
```

Have the client retain only a fixed-size tail of parsed events. Reuse `redactProgressValue`; never retain secret-valued arguments. Treat every MCP call as mutation-capable unless an explicit read-only selector allowlist proves otherwise. Mark an event unsafe when its execution result is missing, errored ambiguously, or cannot be parsed. Attach diagnostics to the terminal response without changing successful result-file acceptance.

- [ ] **Step 4: Run focused diagnostics tests and verify green**

Run: `bun test test/direct-worker-client.test.ts test/delegation-recovery.test.ts`

Expected: PASS; assertions prove no secret string survives client evidence and unknown/malformed data is never retry-safe.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/subagents/protocol-events.ts src/integrations/subagents/client.ts src/integrations/subagents/diagnostics.ts test/direct-worker-client.test.ts test/delegation-recovery.test.ts
git commit -m "feat: capture delegated completion diagnostics"
```

### Task 3: Parent fallback and bounded fresh recovery

**Files:**
- Create: `src/harness/delegation-recovery.ts`
- Modify: `src/harness/delegation-response-actions.ts`
- Modify: `src/harness/delegation-plan.ts`
- Modify: `src/harness/types.ts`
- Test: `test/delegation-recovery.test.ts`

**Interfaces:**
- Consumes: completed delegated response, absent result-file error, `DelegationDiagnostic`, active delegation policy, and current run identity.
- Produces: `missingCompletionDisposition(...)` returning either `{ kind: 'recover', request }` once or `{ kind: 'pause', reason }`.

- [ ] **Step 1: Write failing parent behavior tests**

```ts
test('launches one fresh recovery only after a repaired read-only child still has no result', async () => {
  await finishCompletedMissingResult(readOnlyResponse);
  expect(delegations).toHaveLength(1);
  expect(delegations[0]!.task).toContain('Automatic recovery after subagent failure');
});

test('pauses a mutation-capable missing completion without fresh delegation', async () => {
  await finishCompletedMissingResult(mutatingResponse);
  expect(delegations).toEqual([]);
  expect(pauseReason).toContain('result-path state');
});
```

- [ ] **Step 2: Run focused parent tests and verify red**

Run: `bun test test/delegation-recovery.test.ts`

Expected: FAIL because an `ENOENT` result currently pauses immediately.

- [ ] **Step 3: Implement disposition before parent cleanup**

```ts
if (hasErrorCode(error, 'ENOENT')) {
  const disposition = missingCompletionDisposition({ active, response, run: this.run });
  if (disposition.kind === 'recover') return this.launchRecovery(disposition.request);
  throw new Error(disposition.reason, { cause: error });
}
```

Create a fresh capability/result directory and request only once per original `requestId`; preserve original run/step identity, policy restrictions, and compact recovery prompt. Never reuse an old result path or capability. Include exact request ID, exit code, repair state, and redacted bounded diagnostic summary in pause reasons. Retain current `parseDelegatedStepResult` and cleanup ordering for valid results.

- [ ] **Step 4: Run focused parent tests and verify green**

Run: `bun test test/delegation-recovery.test.ts`

Expected: PASS; read-only recovery is bounded once, all unsafe/incomplete cases pause, and valid result handling is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/harness/delegation-recovery.ts src/harness/delegation-response-actions.ts src/harness/delegation-plan.ts src/harness/types.ts test/delegation-recovery.test.ts
git commit -m "fix: recover safe missing child completions"
```

### Task 4: End-to-end lifecycle coverage and documentation

**Files:**
- Modify: `test/e2e/direct-worker-runtime.test.ts`
- Modify: `test/extension.test.ts`
- Modify: `openwiki/integrations/subagents.md`
- Modify: `docs/superpowers/specs/2026-08-22-delegated-completion-repair-design.md`

**Interfaces:**
- Consumes: direct Pi worker fixture and child runtime repair lifecycle.
- Produces: a regression test proving one child can settle without completion, receive the repair follow-up, and finish with a valid correlated result.

- [ ] **Step 1: Write failing E2E repair scenario**

```ts
// Faux provider: first response for plan is prose-only; repair follow-up responds with structured_output.
expect(checkpoint.status).toBe('completed');
expect(observations.filter(({ step }) => step === 'plan')).toHaveLength(2);
expect(observations[1]!.hasCompletionRepairPrompt).toBe(true);
```

Also update extension registration assertions to require the child `agent_settled` lifecycle handler.

- [ ] **Step 2: Run focused E2E test and verify red**

Run: `bun run test:e2e`

Expected: FAIL or pause at the plan step with missing correlated `structured_output`.

- [ ] **Step 3: Document the enforced recovery behavior**

Add a short `Same-child completion repair` section to `openwiki/integrations/subagents.md`: one repair follow-up; valid result remains mandatory; fresh recovery requires proven read-only evidence; mutation/unknown evidence pauses. Update the spec only if implementation discovers a Pi 0.84.2 lifecycle constraint.

- [ ] **Step 4: Run focused E2E and extension tests and verify green**

Run: `bun test test/extension.test.ts && bun run test:e2e`

Expected: PASS; ordinary direct-worker E2E remains complete and repair scenario produces exactly one additional child turn.

- [ ] **Step 5: Run full verification**

Run: `bun run check`

Expected: exit 0: lint, format check, typecheck, coverage, direct-worker E2E, and build pass.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/direct-worker-runtime.test.ts test/extension.test.ts openwiki/integrations/subagents.md docs/superpowers/specs/2026-08-22-delegated-completion-repair-design.md
git commit -m "test: cover delegated completion repair"
```

## Self-review

- **Spec coverage:** Task 1 implements same-child repair; Task 2 implements bounded diagnostics; Task 3 implements strict fresh-retry disposition; Task 4 proves the lifecycle and documents behavior. Every scope, error-handling, safety, and test requirement maps to a task.
- **Placeholder scan:** No TBD/TODO placeholders or unspecified test steps.
- **Type consistency:** `DelegationDiagnostic` is created in Task 2, attached to `SubagentDelegationResponse`, and consumed by Task 3. `requestCompletionRepair` is created in Task 1 and wired by the existing child runtime.
