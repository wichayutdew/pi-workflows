import { describe, expect, test } from 'bun:test';
import { validateArtifactContract } from '../../src/function/step-result/validate-contract.ts';

const contract = {
  maxChars: 100,
  requiredSubstrings: ['# Plan'],
  forbiddenSubstrings: ['secret'],
  equalOccurrenceGroups: [['**Question:**', '**Answer:**']],
};

describe('when validating a gate artifact contract', () => {
  test('accepts an artifact when no contract is configured', () => {
    expect(validateArtifactContract('anything', undefined)).toBeUndefined();
  });

  test('rejects an artifact exceeding the character limit', () => {
    expect(validateArtifactContract('x'.repeat(101), contract)).toBe(
      'gate artifact exceeds 100 characters',
    );
  });

  test('rejects an artifact missing required text', () => {
    expect(validateArtifactContract('## Evidence', contract)).toBe(
      'gate artifact is missing required text: "# Plan"',
    );
  });

  test('rejects an artifact containing forbidden text', () => {
    expect(validateArtifactContract('# Plan\nsecret', contract)).toBe(
      'gate artifact contains forbidden text: "secret"',
    );
  });

  test('rejects an artifact missing repeated text', () => {
    expect(validateArtifactContract('# Plan\n**Question:**', contract)).toBe(
      'gate artifact is missing required repeated text: ["**Question:**","**Answer:**"]',
    );
  });

  test('rejects an artifact with unequal repeated text', () => {
    expect(
      validateArtifactContract(
        '# Plan\n**Question:**\n**Question:**\n**Answer:**',
        contract,
      ),
    ).toBe(
      'gate artifact has unequal repeated text counts: ["**Question:**","**Answer:**"]',
    );
  });

  test('accepts an artifact satisfying every contract requirement', () => {
    expect(
      validateArtifactContract('# Plan\n**Question:**\n**Answer:**', contract),
    ).toBeUndefined();
  });
});
