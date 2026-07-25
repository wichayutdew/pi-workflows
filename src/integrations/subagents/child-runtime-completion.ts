import { parseDelegatedStepResult } from './delegated-result.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

export const CHILD_COMPLETION_TOOL = 'structured_output';
export const CHILD_COORDINATION_TOOLS: ReadonlySet<string> = new Set([
  'contact_supervisor',
  'subagent_supervisor',
  'intercom',
]);

const STRUCTURED_RESULT_KEYS: ReadonlySet<string> = new Set([
  'outcome',
  'summary',
  'artifact',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates and unwraps a structured-output tool input for a child policy.
 */
export const parseChildStructuredResult = ({
  input,
  policy,
}: {
  readonly input: unknown;
  readonly policy: ChildStepPolicy;
}): ReturnType<typeof parseDelegatedStepResult> => {
  if (!isRecord(input)) {
    throw new Error('structured_output input must be an object');
  }
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'value')) {
    throw new Error('structured_output input must contain only value');
  }
  if (!isRecord(input.value)) {
    throw new Error('structured_output value must be an object');
  }

  const unknownKey = Object.keys(input.value).find(
    (key) => !STRUCTURED_RESULT_KEYS.has(key),
  );
  if (unknownKey) {
    throw new Error(
      `structured_output value has unknown property "${unknownKey}"`,
    );
  }
  return parseDelegatedStepResult(
    {
      version: 1,
      policyDigest: policy.policyDigest,
      ...input.value,
    },
    policy,
  );
};
