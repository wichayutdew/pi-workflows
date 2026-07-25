export const RUN_STATE_VERSION = 1 as const;

export type WorkflowRunStatus =
  'running' | 'paused' | 'awaiting-gate' | 'completed' | 'aborted';

export type StepHistoryEntry = {
  readonly stepId: string;
  readonly stepDigest: string;
  readonly outcome: string;
  readonly summary: string;
  readonly completedAt: number;
};

export type GateResolution = {
  readonly approved: boolean;
  readonly feedback: string;
  readonly resolvedAt: number;
};

export type PendingGate = {
  readonly provider: 'prompt' | 'plannotator';
  readonly requestId: string;
  readonly stepId: string;
  readonly artifact: string;
  /** Legacy v1 field. New runs use the reviewed artifact as the handoff. */
  summary?: string | undefined;
  readonly submittedOutcome: string;
  readonly requestedAt: number;
  readonly reviewId?: string | undefined;
  readonly resolution?: GateResolution | undefined;
};

export type WorkflowRun = {
  readonly stateVersion: typeof RUN_STATE_VERSION;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly input: string;
  readonly status: WorkflowRunStatus;
  readonly currentStepId: string;
  readonly currentStepDigest: string;
  readonly baselineTools: ReadonlyArray<string>;
  readonly visits: Readonly<Record<string, number>>;
  readonly history: ReadonlyArray<StepHistoryEntry>;
  readonly startedAt: number;
  readonly updatedAt: number;
  /**
   * Most recent human-approved gate artifact. This is the only provenance
   * source from which reviewed Bash capabilities may be derived.
   */
  readonly reviewedArtifact?: string | undefined;
  /**
   * Input inherited from the previous completed step. Unlike `lastSummary`,
   * this survives a paused attempt of the current step.
   */
  readonly stepHandoff?: string | undefined;
  readonly lastSummary: string;
  readonly gateFeedback: string;
  readonly pauseReason?: string | undefined;
  readonly pausedFrom?: 'running' | 'awaiting-gate' | undefined;
  /** Current step when execution failed and was paused for a resumable retry. */
  readonly failedStepId?: string | undefined;
  readonly pendingGate?: PendingGate | undefined;
};
