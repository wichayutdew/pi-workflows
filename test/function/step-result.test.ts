import { describe, expect, test } from 'bun:test';
import { parseWorkflowStepResult } from '../../src/domain/index.ts';

const policy = {
  policyDigest: 'policy-1',
  outcomes: ['done', 'submit', 'bind'],
  summaryMaxChars: 1_000,
  gateSubmitOutcome: 'submit',
  workspace: { bindOn: ['bind'], allowedRoots: ['../worktrees'] },
};

const handoff = {
  state: 'Implementation is complete.',
  completed: ['Implemented and verified `src/example.ts` with `bun test`.'],
  remaining: ['No active-step work remains.'],
};

const result = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  policyDigest: 'policy-1',
  outcome: 'done',
  ...handoff,
  ...overrides,
});

describe('when testing step result', () => {
  test('canonicalizes trimmed typed handoff fields', () => {
    expect(
      parseWorkflowStepResult(
        result({
          state: ' Implementation is complete. ',
          completed: [
            ' Implemented and verified `src/example.ts` with `bun test`. ',
          ],
          remaining: [' No active-step work remains. '],
          artifact: 'artifact',
        }),
        policy,
      ),
    ).toEqual({
      version: 1,
      policyDigest: 'policy-1',
      outcome: 'done',
      summary:
        '# Done: Implementation is complete.\n**Completed:**\n- Implemented and verified `src/example.ts` with `bun test`.\n**Remaining:**\n- No active-step work remains.',
      artifact: 'artifact',
    });
  });

  test('rejects legacy and malformed handoff fields', () => {
    const invalid: Array<[Record<string, unknown>, RegExp]> = [
      [{ summary: 'legacy text' }, /unknown property "summary"/],
      [{ state: '' }, /state must be plain non-placeholder text/],
      [{ completed: [] }, /completed must contain one or more items/],
      [
        { remaining: ['- nested list'] },
        /remaining item must be plain non-placeholder text/,
      ],
      [
        { completed: ['│ malformed `src/example.ts`'] },
        /completed item must be plain non-placeholder text/,
      ],
      [
        { completed: ['# heading `src/example.ts`'] },
        /completed item must be plain non-placeholder text/,
      ],
      [
        { completed: ['placeholder'] },
        /completed item must be plain non-placeholder text/,
      ],
      [
        { completed: ['Implemented `src/example.ts`\n- injected item'] },
        /completed item must be plain non-placeholder text/,
      ],
    ];
    for (const [overrides, message] of invalid) {
      expect(() => parseWorkflowStepResult(result(overrides), policy)).toThrow(
        message,
      );
    }
  });

  test('requires typed blocked and retry fields and formats them', () => {
    const nonSuccessPolicy = {
      policyDigest: 'policy-1',
      outcomes: ['blocked', 'retry'],
      summaryMaxChars: 1_000,
    };
    expect(() =>
      parseWorkflowStepResult(result({ outcome: 'blocked' }), nonSuccessPolicy),
    ).toThrow(/question must be a string/);
    expect(() =>
      parseWorkflowStepResult(result({ outcome: 'retry' }), nonSuccessPolicy),
    ).toThrow(/transientFailure must be a string/);
    expect(
      parseWorkflowStepResult(
        result({
          outcome: 'blocked',
          state: 'Authorization matrix is missing.',
          completed: ['Reviewed `docs/authorization.md`.'],
          remaining: ['Apply the supplied role matrix to endpoint policy.'],
          question: 'Which roles may access each endpoint?',
          action:
            'Product owner must provide the endpoint authorization matrix.',
          next: 'Provide the authorization matrix and run `/workflow-resume`.',
        }),
        nonSuccessPolicy,
      ),
    ).toMatchObject({
      summary: expect.stringContaining(
        '**Question:** Which roles may access each endpoint?',
      ),
    });
    expect(() =>
      parseWorkflowStepResult(
        result({
          outcome: 'retry',
          transientFailure: 'The provider returned HTTP 429.',
          retryWhen: 'Retry after the rate-limit window expires.',
          question: 'Should I retry?',
        }),
        nonSuccessPolicy,
      ),
    ).toThrow(/retry result has blocked-only fields/);
  });

  test('preserves artifact, workspace, and checkpoint validation', () => {
    expect(
      parseWorkflowStepResult(
        result({ outcome: 'bind', workspace: { cwd: '/tmp/worktree' } }),
        policy,
      ).workspace,
    ).toEqual({ cwd: '/tmp/worktree' });
    expect(() =>
      parseWorkflowStepResult(
        result({ workspace: { cwd: '/tmp/worktree' } }),
        policy,
      ),
    ).toThrow(/workspace is forbidden/);

    const checkpointPolicy = {
      policyDigest: 'policy-1',
      outcomes: ['checkpoint'],
      summaryMaxChars: 1_000,
    };
    expect(() =>
      parseWorkflowStepResult(
        result({ outcome: 'checkpoint' }),
        checkpointPolicy,
      ),
    ).toThrow(/checkpoint outcome requires progress/);
    expect(
      parseWorkflowStepResult(
        result({
          outcome: 'checkpoint',
          progress: {
            feature: 'auth feature',
            commit: 'abcdef1 implement auth feature',
            changedFiles: ['src/auth.ts'],
            verification: ['bun test: passed'],
            remaining: ['implement profile feature'],
          },
        }),
        checkpointPolicy,
      ).progress?.feature,
    ).toBe('auth feature');
  });
});
