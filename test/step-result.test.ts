import { describe, expect, test } from 'bun:test';
import { parseWorkflowStepResult } from '../src/runtime/step-result.ts';

describe('when testing step result', () => {
  const policy = {
    policyDigest: 'policy-1',
    outcomes: ['done', 'submit', 'bind'],
    summaryMaxChars: 5,
    gateSubmitOutcome: 'submit',
    workspace: {
      bindOn: ['bind'],
      allowedRoots: ['../worktrees'],
    },
  };

  describe('should satisfy its behavioral contract', () => {
    test('normalizes valid workflow results and preserves an optional artifact', () => {
      // given
      // when
      // then
      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: ' done ',
            artifact: 'artifact',
          },
          policy,
        ),
      ).toEqual({
        version: 1,
        policyDigest: 'policy-1',
        outcome: 'done',
        summary: 'done',
        artifact: 'artifact',
      });
    });

    test('rejects non-actionable blocked and retry summaries', () => {
      const nonSuccessPolicy = {
        policyDigest: 'policy-1',
        outcomes: ['done', 'blocked', 'retry'],
        summaryMaxChars: 1_000,
      };

      const invalid: Array<[string, string, RegExp]> = [
        [
          'blocked',
          'error',
          /blocked summary must identify the missing user prerequisite and next action/,
        ],
        [
          'blocked',
          '# Blocked: Need input\n**Next:** resume.',
          /blocked summary must identify the missing user prerequisite and next action/,
        ],
        [
          'retry',
          '# Retry: Need requirements\n**Next:** provide details.',
          /retry summary must identify a transient failure and safe retry condition/,
        ],
      ];

      for (const [outcome, summary, message] of invalid) {
        expect(() =>
          parseWorkflowStepResult(
            { version: 1, policyDigest: 'policy-1', outcome, summary },
            nonSuccessPolicy,
          ),
        ).toThrow(message);
      }

      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'blocked',
            summary:
              '# Blocked: Missing authorization matrix.\n1. **Authorization policy** — no role matrix was supplied.\n   **Action:** Product owner must provide the endpoint authorization matrix.\n**Next:** Provide the authorization matrix and run `/workflow-resume`.',
          },
          nonSuccessPolicy,
        ),
      ).toMatchObject({ outcome: 'blocked' });
    });

    test('requires workspace cwd exactly on configured binding outcomes', () => {
      expect(
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: 'bound',
            workspace: { cwd: '/tmp/worktree ' },
          },
          policy,
        ),
      ).toEqual({
        version: 1,
        policyDigest: 'policy-1',
        outcome: 'bind',
        summary: 'bound',
        workspace: { cwd: '/tmp/worktree ' },
      });

      const invalid: Array<[unknown, RegExp]> = [
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: 'bound',
          },
          /requires workspace\.cwd/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: 'done',
            workspace: { cwd: '/tmp/worktree' },
          },
          /workspace is forbidden/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: 'bound',
            workspace: { cwd: 'relative/worktree' },
          },
          /must be an absolute path/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: 'bound',
            workspace: { cwd: `/${'x'.repeat(4_096)}` },
          },
          /exceeds 4096 characters/,
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'bind',
            summary: 'bound',
            workspace: { cwd: '/tmp/worktree', extra: true },
          },
          /workspace has unknown property/,
        ],
      ];
      for (const [value, message] of invalid) {
        expect(() => parseWorkflowStepResult(value, policy)).toThrow(message);
      }
    });

    test('rejects malformed workflow results', () => {
      // given
      // when
      const invalid: Array<[unknown, string]> = [
        [null, 'must be an object'],
        [{ extra: true }, 'unknown property'],
        [{ version: 2 }, 'unsupported'],
        [{ version: 1, policyDigest: 'wrong' }, 'does not match'],
        [
          { version: 1, policyDigest: 'policy-1', outcome: 'nope' },
          'invalid outcome',
        ],
        [
          { version: 1, policyDigest: 'policy-1', outcome: 'done', summary: 1 },
          'must be a string',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: '   ',
          },
          'must not be empty',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: 'too long',
          },
          'exceeds 5',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: 'done',
            artifact: 1,
          },
          'artifact must be a string',
        ],
        [
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'submit',
            summary: 'done',
          },
          'requires a non-empty artifact',
        ],
      ];

      // then
      for (const [value, message] of invalid) {
        expect(() => parseWorkflowStepResult(value, policy)).toThrow(
          new RegExp(message),
        );
      }
      expect(() =>
        parseWorkflowStepResult(
          {
            version: 1,
            policyDigest: 'policy-1',
            outcome: 'done',
            summary: 'done',
            artifact: 'x'.repeat(200_001),
          },
          policy,
        ),
      ).toThrow(/exceeds 200000/);
    });
  });
});
