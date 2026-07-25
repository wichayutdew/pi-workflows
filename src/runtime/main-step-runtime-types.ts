import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowStep } from '../config/types.ts';
import type { invalidCompletionCallIds } from '../policy/completion-batch.ts';
import type { freezeToolInput } from '../policy/immutable-input.ts';
import type { authorizeToolCall, resolveActiveTools } from '../policy/tools.ts';
import type {
  parseWorkflowStepResult,
  StepResultPolicy,
  WorkflowStepResult,
} from './step-result.ts';

/**
 * Identity, policy, and settlement callback for one main-agent step.
 */
export type MainStepExecution = StepResultPolicy & {
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepDigest: string;
  readonly step: WorkflowStep;
  readonly approvedBashCommands: ReadonlyArray<string>;
  /** Handles the captured result after Pi fully settles the agent run. */
  readonly onSettled: (
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void> | void;
};

/**
 * Functional controller consumed by the workflow harness.
 */
export type MainStepRuntimeController = {
  /** ID of the currently active workflow step. */
  readonly activeStepId: string | undefined;
  /** Activates one workflow step. */
  readonly activate: (execution: MainStepExecution) => void;
  /** Clears the active step and reports whether one existed. */
  readonly deactivate: () => boolean;
  /** Clears the active step and blocks tools until released. */
  readonly suspend: () => boolean;
  /** Allows a future step to be activated. */
  readonly release: () => void;
};

/**
 * Injectable policy and parsing operations used by the runtime.
 */
export type MainStepRuntimeDependencies = {
  readonly invalidCompletionCallIds: typeof invalidCompletionCallIds;
  readonly freezeToolInput: typeof freezeToolInput;
  readonly authorizeToolCall: typeof authorizeToolCall;
  readonly resolveActiveTools: typeof resolveActiveTools;
  readonly parseWorkflowStepResult: typeof parseWorkflowStepResult;
};

/**
 * Mutable state isolated within one runtime controller closure.
 */
export type MainStepRuntimeState = {
  active: MainStepExecution | undefined;
  pendingResult: WorkflowStepResult | undefined;
  invalidCompletionCalls: ReadonlySet<string>;
  isSuspended: boolean;
};
