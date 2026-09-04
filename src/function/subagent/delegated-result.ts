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
