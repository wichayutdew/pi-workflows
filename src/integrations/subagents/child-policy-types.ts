import type {
  StepPermissions,
  StepWorkspaceBinding,
} from '../../config/types.ts';

export type ChildStepPolicy = {
  readonly version: 1;
  readonly requestId: string;
  readonly agent: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  /** Effective run directory: the captured start cwd or accepted binding. */
  readonly cwd: string;
  readonly policyDigest: string;
  readonly capabilityPath: string;
  readonly capabilityToken: string;
  readonly resultPath: string;
  readonly permissions: StepPermissions;
  readonly outcomes: ReadonlyArray<string>;
  /** Outcomes that pause instead of advancing to another workflow step. */
  readonly pauseOutcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  readonly gateSubmitOutcome?: string;
  readonly workspace?: StepWorkspaceBinding;
};

export type ExtractedChildPolicy = {
  readonly policy: ChildStepPolicy;
  readonly task: string;
};
