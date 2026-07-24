import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkflowStepResult } from '../src/runtime/step-result.ts';

const policy = {
  policyDigest: 'policy-1',
  outcomes: ['done', 'submit'],
  summaryMaxChars: 5,
  gateSubmitOutcome: 'submit',
};

test('normalizes valid workflow results and preserves an optional artifact', () => {
  assert.deepEqual(
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
    {
      version: 1,
      policyDigest: 'policy-1',
      outcome: 'done',
      summary: 'done',
      artifact: 'artifact',
    },
  );
});

test('rejects malformed workflow results', () => {
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
      { version: 1, policyDigest: 'policy-1', outcome: 'done', summary: '   ' },
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

  for (const [value, message] of invalid) {
    assert.throws(
      () => parseWorkflowStepResult(value, policy),
      new RegExp(message),
    );
  }
  assert.throws(
    () =>
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
    /exceeds 200000/,
  );
});
