import type {
  ChildStepPolicy,
  WorkflowStepResult,
} from '../../domain/index.ts';
import { parseWorkflowStepResult } from '../step-result/parse-result.ts';

export type DelegatedStepResult = WorkflowStepResult;

/**
 * Validates a child completion value against its delegated step policy.
 *
 * @throws When the completion value violates the delegated step contract.
 */
export const parseDelegatedStepResult = (
  value: unknown,
  policy: ChildStepPolicy,
): DelegatedStepResult => {
  try {
    return parseWorkflowStepResult(value, {
      policyDigest: policy.policyDigest,
      outcomes: [...policy.outcomes],
      summaryMaxChars: policy.summaryMaxChars,
      ...(policy.gateSubmitOutcome
        ? { gateSubmitOutcome: policy.gateSubmitOutcome }
        : {}),
      ...(policy.workspace ? { workspace: policy.workspace } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll('workflow step', 'delegated step'), {
      cause: error,
    });
  }
};

/** Validates the already-canonical result written by the child runtime. */
export const parsePersistedDelegatedStepResult = (
  value: unknown,
  policy: ChildStepPolicy,
): DelegatedStepResult => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).policyDigest !== policy.policyDigest ||
    typeof (value as Record<string, unknown>).outcome !== 'string' ||
    !policy.outcomes.includes(
      (value as Record<string, unknown>).outcome as string,
    ) ||
    typeof (value as Record<string, unknown>).summary !== 'string'
  ) {
    throw new Error('delegated step persisted result is invalid');
  }
  return value as DelegatedStepResult;
};
