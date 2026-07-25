import type { StepPermissions } from '../../config/types.ts';

export type ChildStepPolicy = {
  readonly version: 1;
  readonly requestId: string;
  readonly agent: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly policyDigest: string;
  readonly capabilityPath: string;
  readonly capabilityToken: string;
  readonly resultPath: string;
  readonly permissions: StepPermissions;
  /** Exact Bash command strings extracted from a reviewed gate artifact. */
  readonly approvedBashCommands?: ReadonlyArray<string>;
  /** Reviewed repository root that file mutations must remain inside. */
  readonly repositoryCwd?: string;
  /** Existing reviewed source directory used only to bootstrap repositoryCwd. */
  readonly bootstrapCwd?: string;
  readonly outcomes: ReadonlyArray<string>;
  /** Outcomes that pause instead of advancing to another workflow step. */
  readonly pauseOutcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  readonly gateSubmitOutcome?: string;
};

export type ExtractedChildPolicy = {
  readonly policy: ChildStepPolicy;
  readonly task: string;
};
