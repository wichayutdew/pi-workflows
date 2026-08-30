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
  /** Productive calls available before the mandatory handoff reserve. */
  readonly maxToolCalls?: number;
  /** Calls reserved for the child to hand off after productive work. */
  readonly handoffReserve?: number;
  /** Productive calls plus the mandatory handoff reserve. */
  readonly totalToolCalls?: number;
  readonly gateSubmitOutcome?: string;
  readonly workspace?: StepWorkspaceBinding;
};

export type ExtractedChildPolicy = {
  readonly policy: ChildStepPolicy;
  readonly task: string;
};
