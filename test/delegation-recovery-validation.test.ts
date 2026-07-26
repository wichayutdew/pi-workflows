import { describe, expect, test } from 'bun:test';
import type { ToolFailureDiagnostic } from '../src/integrations/subagents/diagnostics.ts';
import type {
  ChildStepPolicy,
  SubagentDelegationResponse,
} from '../src/integrations/subagents/protocol.ts';
import {
  completionMatchesResult,
  recoveredProjectionError,
} from '../src/harness/delegation-recovery-validation.ts';
import type { ActiveDelegation } from '../src/harness/types.ts';

const FAILURE_ERROR = 'bash failed (exit 1): missing path';

function childPolicy(): ChildStepPolicy {
  return {
    version: 1,
    requestId: 'request-1',
    agent: 'worker',
    workflowId: 'example',
    runId: 'run-1',
    stepId: 'inspect',
    stepTitle: 'Inspect',
    cwd: '/repository',
    policyDigest: 'a'.repeat(64),
    capabilityPath: '/private/result/capability',
    capabilityToken: 'b'.repeat(64),
    resultPath: '/private/result/result.json',
    permissions: {
      tools: ['bash'],
      mcp: [],
      extensions: [],
      skills: [],
      bash: { mode: 'deny', allow: [] },
    },
    outcomes: ['done'],
    pauseOutcomes: [],
    summaryMaxChars: 1_000,
  };
}

function activeDelegation(): ActiveDelegation {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    stepId: 'inspect',
    stepDigest: 'step-digest',
    sessionEpoch: 1,
    resultDirectory: '/private/result',
    policy: childPolicy(),
    transcriptTask: 'Inspect the repository',
    agent: 'worker',
    broadRecoveryAuthorized: false,
    recoveryAttemptCount: 0,
    recoveryFailures: [],
  };
}

function failedExecution(
  overrides: Partial<NonNullable<SubagentDelegationResponse['execution']>> = {},
): NonNullable<SubagentDelegationResponse['execution']> {
  return {
    status: 'failed',
    success: false,
    exitCode: 1,
    error: FAILURE_ERROR,
    ...overrides,
  };
}

function failedResponse(
  overrides: Partial<SubagentDelegationResponse> = {},
): SubagentDelegationResponse {
  return {
    version: 1,
    requestId: 'request-1',
    status: 'failed',
    agent: 'worker',
    childIndex: 0,
    exitCode: 1,
    error: FAILURE_ERROR,
    execution: failedExecution(),
    toolCount: 1,
    turns: 1,
    ...overrides,
  };
}

describe('when validating recovered delegation evidence', () => {
  test('matches only exact, policy-valid structured completion values', () => {
    const policy = childPolicy();
    const result = {
      version: 1 as const,
      policyDigest: policy.policyDigest,
      outcome: 'done',
      summary: 'Recovered',
    };

    expect(
      completionMatchesResult(
        {
          tool: 'bash',
          completionValue: { outcome: 'done', summary: 'Recovered' },
        },
        result,
        policy,
      ),
    ).toBe(true);
    expect(completionMatchesResult({ tool: 'bash' }, result, policy)).toBe(
      false,
    );
    expect(
      completionMatchesResult(
        {
          tool: 'bash',
          completionValue: {
            outcome: 'done',
            summary: 'Recovered',
            unexpected: true,
          },
        },
        result,
        policy,
      ),
    ).toBe(false);
    expect(
      completionMatchesResult(
        {
          tool: 'bash',
          completionValue: { outcome: 'unknown', summary: 'Recovered' },
        },
        result,
        policy,
      ),
    ).toBe(false);

    const workspacePolicy: ChildStepPolicy = {
      ...policy,
      outcomes: ['bound'],
      workspace: {
        bindOn: ['bound'],
        allowedRoots: ['../worktrees'],
      },
    };
    const workspaceResult = {
      ...result,
      outcome: 'bound',
      workspace: { cwd: '/tmp/worktree' },
    };
    expect(
      completionMatchesResult(
        {
          tool: 'bash',
          completionValue: {
            outcome: 'bound',
            summary: 'Recovered',
            workspace: { cwd: '/tmp/worktree' },
          },
        },
        workspaceResult,
        workspacePolicy,
      ),
    ).toBe(true);
    expect(
      completionMatchesResult(
        {
          tool: 'bash',
          completionValue: {
            outcome: 'bound',
            summary: 'Recovered',
            workspace: { cwd: '/tmp/other-worktree' },
          },
        },
        workspaceResult,
        workspacePolicy,
      ),
    ).toBe(false);
  });

  test('rejects every contradictory terminal projection field', () => {
    const active = activeDelegation();
    const diagnostic: ToolFailureDiagnostic = {
      tool: 'bash',
      transcriptToolCount: 1,
      transcriptTurnCount: 1,
    };

    expect(
      recoveredProjectionError(active, failedResponse(), diagnostic),
    ).toBeUndefined();
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ agent: 'other-worker' }),
        diagnostic,
      ),
    ).toContain('agent identity');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ childIndex: 1 }),
        diagnostic,
      ),
    ).toContain('child index');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ exitCode: 0 }),
        diagnostic,
      ),
    ).toContain('positive safe integer');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ execution: failedExecution({ exitCode: 2 }) }),
        diagnostic,
      ),
    ).toContain('execution exit code');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ warnings: ['unexpected warning'] }),
        diagnostic,
      ),
    ).toContain('warning evidence');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ toolCount: 2 }),
        diagnostic,
      ),
    ).toContain('transcript tool count');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({ turns: 2 }),
        diagnostic,
      ),
    ).toContain('transcript turn count');
    expect(
      recoveredProjectionError(active, failedResponse(), {
        ...diagnostic,
        tool: 'read',
      }),
    ).toContain('does not match the correlated failure');
    expect(
      recoveredProjectionError(
        active,
        failedResponse({
          execution: failedExecution({ interrupted: true }),
        }),
        diagnostic,
      ),
    ).toContain('interrupted=true');
  });
});
