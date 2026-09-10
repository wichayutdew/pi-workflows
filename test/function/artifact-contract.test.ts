import { describe, expect, test } from 'bun:test';
import type { ArtifactContract } from '../../src/domain/index.ts';
import { validateArtifactContract } from '../../src/function/step-result/validate-contract.ts';

const contract = {
  maxChars: 100,
  requiredHeadings: [
    { level: 1, title: 'Report destination', guidance: 'Exact report path.' },
    {
      level: 2,
      title: 'Validation',
      guidance: 'Independent commands and proof.',
    },
  ],
} satisfies ArtifactContract;

describe('when validating a gate artifact contract', () => {
  test('accepts an artifact when no contract is configured', () => {
    expect(validateArtifactContract('anything', undefined)).toBeUndefined();
  });

  test('rejects an artifact exceeding the character limit', () => {
    expect(validateArtifactContract('x'.repeat(101), contract)).toBe(
      'gate artifact exceeds 100 characters',
    );
  });

  test('rejects an artifact missing a required heading', () => {
    expect(validateArtifactContract('## Validation', contract)).toBe(
      'gate artifact is missing required heading: "# Report destination"',
    );
  });

  test('rejects a required heading at the wrong level', () => {
    expect(
      validateArtifactContract('# Report destination\n# Validation', contract),
    ).toBe('gate artifact is missing required heading: "## Validation"');
  });

  test('rejects headings found only inside a fenced code block', () => {
    expect(
      validateArtifactContract(
        '```md\n# Report destination\n## Validation\n```',
        contract,
      ),
    ).toBe(
      'gate artifact is missing required heading: "# Report destination"',
    );
  });

  test('accepts an artifact containing every required Markdown heading', () => {
    expect(
      validateArtifactContract(
        '# Report destination\n/tmp/report.md\n\n## Validation\nbun test',
        contract,
      ),
    ).toBeUndefined();
  });
});
