import { describe, expect, test } from 'bun:test';
import { parseWorkflowStepResult } from '../src/runtime/step-result.ts';

describe('when testing step result', () => {
  const policy = {
    policyDigest: 'policy-1',
    outcomes: ['done', 'submit'],
    summaryMaxChars: 5,
    gateSubmitOutcome: 'submit',
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
