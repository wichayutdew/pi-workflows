import { describe, expect, test } from 'bun:test';
import type { ChildStepPolicy } from '../src/integrations/subagents/protocol.ts';
import type { HarnessActionContext } from '../src/harness/action-context.ts';
import { createDelegationControlActions } from '../src/harness/delegation-control-actions.ts';
import { createDelegationFailureActions } from '../src/harness/delegation-failure.ts';
import { createDelegationResponseActions } from '../src/harness/delegation-response-actions.ts';
import { createStepExecutionActions } from '../src/harness/step-execution-actions.ts';
import type { ActiveDelegation } from '../src/harness/types.ts';
import { createRun } from '../src/engine/state.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

function childPolicy(tools: ReadonlyArray<string> = ['read']): ChildStepPolicy {
  return {
    version: 1,
    requestId: 'request-1',
    agent: 'worker',
    workflowId: 'example',
    runId: 'run-1',
    stepId: 'inspect',
    stepTitle: 'Inspect',
    policyDigest: 'a'.repeat(64),
    capabilityPath: '/private/result/capability',
    capabilityToken: 'b'.repeat(64),
    resultPath: '/private/result/result.json',
    permissions: {
      tools,
      mcp: [],
      extensions: [],
      skills: [],
      bash: { mode: 'read-only', allow: [] },
    },
    outcomes: ['done', 'blocked'],
    pauseOutcomes: ['blocked'],
    summaryMaxChars: 1_000,
  };
}

function activeDelegation(
  overrides: Partial<ActiveDelegation> = {},
): ActiveDelegation {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    stepId: 'inspect',
    stepDigest: 'step-digest',
    sessionEpoch: 2,
    resultDirectory: '/private/result',
    policy: childPolicy(),
    transcriptTask: 'Inspect the repository',
    agent: 'worker',
    broadRecoveryAuthorized: false,
    recoveryAttemptCount: 0,
    recoveryFailures: [],
    ...overrides,
  };
}

describe('when testing delegation edge actions', () => {
  test('bounds an oversized recovery error without losing its ends', () => {
    const actions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => undefined,
      readToolFailureDiagnostic: async () => undefined,
    });
    const detail = `${'a'.repeat(1_000)}${'z'.repeat(1_000)}`;

    const reason = actions.rejectedRecoveryReason(
      { reason: 'Subagent failed.', status: 'failed' },
      detail,
    );

    expect(reason).toContain('… [truncated] …');
    expect(reason).toContain('a'.repeat(100));
    expect(reason).toContain('z'.repeat(100));
    expect(reason.length).toBeLessThan(detail.length);
  });

  test('fingerprints repeated semantic failures independently of session paths', () => {
    const actions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => undefined,
      readToolFailureDiagnostic: async () => undefined,
    });
    const first = {
      reason: 'Diagnostic session: /sessions/first/run-0/session.jsonl',
      status: 'failed' as const,
      error: ' read failed (exit 1): missing input ',
      exitCode: 1,
      diagnostic: {
        tool: 'read',
        call: '  {"path":"/missing/input.md"} ',
        output: 'file   not found',
      },
    };
    const repeated = {
      ...first,
      reason: 'Diagnostic session: /sessions/second/run-0/session.jsonl',
      error: 'read failed (exit 1): missing input',
      diagnostic: {
        tool: 'read',
        call: '{"path":"/missing/input.md"}',
        output: 'file not found',
      },
    };
    const distinct = {
      ...repeated,
      diagnostic: {
        ...repeated.diagnostic,
        call: '{"path":"/missing/alternative.md"}',
      },
    };

    expect(actions.delegationFailureFingerprint(repeated)).toBe(
      actions.delegationFailureFingerprint(first),
    );
    expect(actions.delegationFailureFingerprint(distinct)).not.toBe(
      actions.delegationFailureFingerprint(first),
    );
  });

  test('allows audited replay-safe recovery even when the step exposes mutation tools', () => {
    const actions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => undefined,
      readToolFailureDiagnostic: async () => undefined,
    });

    expect(
      actions.isSafeToRetryDelegation(
        childPolicy(['read', 'edit', 'write']),
        false,
        { replaySafe: true, toolCount: 1 },
      ),
    ).toBe(true);
    expect(
      actions.isSafeToRetryDelegation(
        childPolicy(['read', 'edit', 'write']),
        false,
        { replaySafe: false, toolCount: 1 },
      ),
    ).toBe(false);
  });

  test('keeps interrupted, stopped, and detached executions non-retryable', async () => {
    const actions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => ({
        replaySafe: true,
        toolCount: 0,
      }),
      readToolFailureDiagnostic: async () => undefined,
    });
    const active = activeDelegation();
    const terminalResponses = [
      {
        status: 'interrupted' as const,
        error: 'child execution was interrupted',
        exitCode: 1,
      },
      {
        status: 'failed' as const,
        error: 'child execution stopped',
        exitCode: 1,
        execution: {
          status: 'stopped' as const,
          success: false,
          exitCode: 1,
          error: 'child execution stopped',
          stopped: true,
        },
      },
      {
        status: 'failed' as const,
        error: 'child execution detached',
        exitCode: 1,
        execution: {
          status: 'detached' as const,
          success: false,
          exitCode: 1,
          error: 'child execution detached',
          detached: true,
        },
      },
      {
        status: 'failed' as const,
        error: 'child execution was interrupted',
        exitCode: 1,
        execution: {
          status: 'paused' as const,
          success: false,
          exitCode: 1,
          error: 'child execution was interrupted',
          interrupted: true,
        },
      },
    ];

    for (const response of terminalResponses) {
      const failure = await actions.describeDelegationFailure(active, {
        version: 1,
        requestId: active.requestId,
        runId: 'child-run',
        childIndex: 0,
        ...response,
      });

      expect(actions.isRetryableTerminalFailure(failure)).toBe(false);
    }
  });

  test('does not retry when the terminal response reports attempted or observed file mutation', async () => {
    const actions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => ({
        replaySafe: true,
        toolCount: 0,
      }),
      readToolFailureDiagnostic: async () => undefined,
    });
    const active = activeDelegation();
    const fileMutationResults = [
      {
        status: 'missing' as const,
        expected: true,
        attempted: true,
        message: 'the child attempted a file mutation',
      },
      {
        status: 'observed' as const,
        expected: false,
        attempted: false,
        message: 'the child produced an unexpected file mutation',
      },
    ];

    for (const fileMutation of fileMutationResults) {
      const failure = await actions.describeDelegationFailure(active, {
        version: 1,
        requestId: active.requestId,
        status: 'failed',
        error: 'child failed after touching workspace files',
        exitCode: 1,
        runId: 'child-run',
        childIndex: 0,
        effects: { fileMutation },
      });

      expect(actions.isRetryableTerminalFailure(failure)).toBe(false);
    }
  });

  test('allows audited timeout and budget recovery but rejects incomplete audit evidence', async () => {
    const auditedActions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => ({
        replaySafe: true,
        toolCount: 0,
      }),
      readToolFailureDiagnostic: async () => undefined,
    });
    const incompleteActions = createDelegationFailureActions({
      readDelegationReplayAudit: async () => ({
        replaySafe: false,
        toolCount: 0,
      }),
      readToolFailureDiagnostic: async () => undefined,
    });
    const active = activeDelegation();

    for (const status of [
      'timed_out',
      'turn_budget_exhausted',
      'tool_budget_exhausted',
    ] as const) {
      const response = {
        version: 1 as const,
        requestId: active.requestId,
        status,
        error: `${status} before completion`,
        exitCode: 1,
        runId: 'child-run',
        childIndex: 0,
      };
      const auditedFailure = await auditedActions.describeDelegationFailure(
        active,
        response,
      );
      const incompleteFailure =
        await incompleteActions.describeDelegationFailure(active, response);

      expect(auditedActions.isRetryableTerminalFailure(auditedFailure)).toBe(
        true,
      );
      expect(
        auditedActions.isSafeToRetryDelegation(
          active.policy,
          active.broadRecoveryAuthorized,
          auditedFailure.replayAudit,
        ),
      ).toBe(true);
      expect(
        incompleteActions.isSafeToRetryDelegation(
          active.policy,
          active.broadRecoveryAuthorized,
          incompleteFailure.replayAudit,
        ),
      ).toBe(false);
    }
  });

  test('warns without throwing when a delegation workspace cannot be removed', async () => {
    const notifications: Array<{
      message: string;
      type: string | undefined;
    }> = [];
    const active = activeDelegation();
    const fixture = {
      dependencies: {
        removeDelegationWorkspace: async () => {
          throw new Error('temporary directory is busy');
        },
      },
      latestContext: {
        ui: {
          notify(message: string, type: string | undefined) {
            notifications.push({ message, type });
          },
        },
      },
    };

    await createDelegationControlActions().cleanupDelegation.call(
      fixture as unknown as HarnessActionContext,
      active,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: 'warning' });
    expect(notifications[0]?.message).toContain(active.resultDirectory);
    expect(notifications[0]?.message).toContain('temporary directory is busy');
  });

  test('routes a synchronous delegation startup error through queued failure handling', async () => {
    const raw = baseWorkflow();
    const steps = raw.steps as Record<string, Record<string, unknown>>;
    steps.inspect = { ...steps.inspect, subagent: {} };
    const workflow = loadedWorkflow(raw);
    const run = createRun(workflow, '', ['read'], 'run-1', 1);
    const failures: Array<{ active: ActiveDelegation; reason: string }> = [];
    const fixture = {
      activeDelegation: undefined as ActiveDelegation | undefined,
      run,
      sessionEpoch: 2,
      latestContext: undefined,
      mainSteps: { activeStepId: undefined },
      dependencies: {
        createRequestId: () => 'delegation-1',
        currentWorkingDirectory: () => '/repository',
        createDelegationWorkspace: () => ({
          resultDirectory: '/private/delegation',
          capabilityPath: '/private/delegation/capability',
          capabilityToken: 'c'.repeat(64),
          resultPath: '/private/delegation/result.json',
        }),
      },
      subagents: {
        delegate: () => {
          throw new Error('delegation transport threw synchronously');
        },
      },
      handleDelegationUpdate: () => undefined,
      queueDelegationResponse: () => undefined,
      queueDelegationFailure: (active: ActiveDelegation, reason: string) => {
        failures.push({ active, reason });
      },
      updateStatus: () => undefined,
      pauseForExecutionFailure: () => undefined,
      launchMainStep: () => undefined,
    };

    expect(() =>
      createStepExecutionActions().launchCurrentStep.call(
        fixture as unknown as HarnessActionContext,
        workflow,
      ),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.active).toBe(fixture.activeDelegation);
    expect(failures[0]?.reason).toBe(
      'delegation transport threw synchronously',
    );
  });

  test('pauses safely when active workflow configuration disappears', async () => {
    const workflow = loadedWorkflow();
    const run = createRun(workflow, '', ['read'], 'run-1', 1);
    const active = {
      ...activeDelegation(),
      stepDigest: run.currentStepDigest,
    };
    const calls = {
      cleaned: 0,
      pauseReasons: [] as Array<string>,
    };
    const fixture = {
      activeDelegation: active as ActiveDelegation | undefined,
      catalog: { workflows: new Map() },
      dependencies: {
        now: () => 10,
        readDelegatedResult: async () => '',
      },
      isSessionActive: true,
      run,
      sessionEpoch: 2,
      cleanupDelegation: async () => {
        calls.cleaned += 1;
      },
      delegationFailures: {},
      pauseForDelegationFailure: (reason: string) => {
        calls.pauseReasons.push(reason);
      },
      releaseMainAfterCancellation: () => {},
      retryDelegationAfterFailure: () => false,
    };

    await createDelegationResponseActions().finishDelegation.call(
      fixture as unknown as HarnessActionContext,
      active,
      {
        version: 1,
        requestId: 'request-1',
        status: 'completed',
      },
    );

    expect(fixture.activeDelegation).toBeUndefined();
    expect(calls.pauseReasons).toEqual([
      'Active workflow configuration is unavailable',
    ]);
    expect(calls.cleaned).toBe(1);
  });
});
