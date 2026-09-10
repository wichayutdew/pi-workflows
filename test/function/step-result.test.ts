import { describe, expect, test } from 'bun:test';
import { parseWorkflowStepResult } from '../../src/domain/index.ts';

const policy = {
  policyDigest: 'policy-1',
  outcomes: ['ready', 'blocked', 'handoff', 'gaps'],
  summaryMaxChars: 1_000,
};

const result = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  policyDigest: 'policy-1',
  outcome: 'ready',
  completed: ['Implemented and verified `src/example.ts` with `bun test`.'],
  remaining: ['No active-step work remains.'],
  ...overrides,
});

describe('when testing step result', () => {
  test('canonicalizes only outcome, completed, and remaining', () => {
    expect(parseWorkflowStepResult(result(), policy)).toEqual({
      version: 1,
      policyDigest: 'policy-1',
      outcome: 'ready',
      summary:
        '# Ready\n**Completed:**\n- Implemented and verified `src/example.ts` with `bun test`.\n**Remaining:**\n- No active-step work remains.',
    });
  });

  test('rejects legacy model-authored handoff fields', () => {
    for (const key of [
      'summary',
      'state',
      'question',
      'action',
      'next',
      'transientFailure',
      'retryWhen',
      'progress',
    ]) {
      expect(() =>
        parseWorkflowStepResult(result({ [key]: 'legacy' }), policy),
      ).toThrow(new RegExp(`unknown property "${key}"`));
    }
  });

  test('enforces outcome-specific remaining semantics', () => {
    expect(() =>
      parseWorkflowStepResult(
        result({ remaining: ['Continue implementation.'] }),
        policy,
      ),
    ).toThrow(/ready result must have no active-step work remaining/);
    expect(() =>
      parseWorkflowStepResult(
        result({ outcome: 'blocked', remaining: ['Await input.'] }),
        policy,
      ),
    ).toThrow(/blocked result must include a user question in remaining/);
    expect(() =>
      parseWorkflowStepResult(
        result({
          outcome: 'handoff',
          remaining: ['Which branch should be used?'],
        }),
        policy,
      ),
    ).toThrow(/handoff result must not include a user question/);
    expect(
      parseWorkflowStepResult(
        result({
          outcome: 'blocked',
          remaining: ['Which branch should be used?'],
        }),
        policy,
      ).summary,
    ).toContain('# Blocked');
    expect(
      parseWorkflowStepResult(
        result({
          outcome: 'handoff',
          remaining: ['Run `bun test` and repair failures.'],
        }),
        policy,
      ).summary,
    ).toContain('# Handoff');
    expect(
      parseWorkflowStepResult(
        result({
          outcome: 'gaps',
          remaining: ['Refresh the acceptance criteria in `PLAN.md`.'],
        }),
        policy,
      ).summary,
    ).toContain('# Gaps');
  });
});
