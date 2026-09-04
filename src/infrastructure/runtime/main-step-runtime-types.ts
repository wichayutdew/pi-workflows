import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  StepResultPolicy,
  WorkflowStep,
  WorkflowStepResult,
} from '../../domain/index.ts';
import type {
  authorizeToolCall,
  freezeToolInput,
  invalidCompletionCallIds,
  ModelUsage,
  parseWorkflowStepResult,
  resolveActiveTools,
} from '../../function/index.ts';

/**
 * Identity, policy, and settlement callback for one main-agent step.
 */
export type MainStepExecution = StepResultPolicy & {
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepDigest: string;
  /** Exact task whose finalized user message arms this attempt's trace. */
  readonly task: string;
  readonly step: WorkflowStep;
  /** Persists one finalized, already-redacted turn before Pi begins a later turn. */
  readonly onTrace: (
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
    usage?: ReadonlyArray<ModelUsage>,
  ) => Promise<void> | void;
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
  traceArmed: boolean;
  traceClosed: boolean;
  isSuspended: boolean;
};
