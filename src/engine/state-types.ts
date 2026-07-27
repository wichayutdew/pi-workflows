export const RUN_STATE_VERSION = 1 as const;
export const MAX_GATE_FEEDBACK_CHARS = 50_000;
export const MAX_RESUME_INPUT_CHARS = 16_000;
export const MAX_STEP_TRACE_TASK_CHARS = 64_000;
export const MAX_STEP_TRACE_ATTEMPTS = 16;
export const MAX_STEP_TRACE_SUMMARY_CHARS = 8_000;
export const MAX_STEP_TRACE_ARTIFACT_CHARS = 16_000;
export const MAX_STEP_TRACE_LOG_EVENTS = 400;
export const MAX_STEP_TRACE_LOG_EVENT_CHARS = 2_000;
export const MAX_STEP_TRACE_LOG_CHARS = 120_000;
export const MAX_WORKFLOW_TRACE_CHARS = 2_000_000;

export type WorkflowRunStatus =
  'running' | 'paused' | 'awaiting-gate' | 'completed' | 'aborted';

export type GateApproval = {
  /** Stable identity of the gate request that produced this approval. */
  readonly requestId: string;
  readonly artifact: string;
  readonly feedback: string;
  /** Prompt-excluded step structure approved by this gate request. */
  readonly stepStructuralDigest: string;
};

export type StepAttemptResult = {
  readonly outcome: string;
  readonly summary: string;
  readonly summaryTruncated?: true | undefined;
  readonly artifact?: string | undefined;
  readonly artifactTruncated?: true | undefined;
  readonly workspaceCwd?: string | undefined;
};

export type StepGateDecision = {
  readonly provider: 'prompt' | 'plannotator';
  readonly requestId: string;
  readonly approved: boolean;
  readonly feedback: string;
  readonly feedbackTruncated?: true | undefined;
  readonly resolvedAt: number;
  readonly reviewId?: string | undefined;
};

export type SubagentTranscriptReference = {
  /** Trusted parent-derived directory containing this child run. */
  readonly trustedRoot: string;
  /** Exact child session returned by the delegation protocol. */
  readonly sessionFile: string;
  /** Pi-subagents run identity used to confine the session path. */
  readonly runId: string;
  readonly childIndex: number;
};

export type StepExecutionAttempt =
  | {
      readonly kind: 'main';
      readonly requestId: string;
      /** One-based attempt position within this step visit. */
      readonly ordinal?: number | undefined;
      /** Exact workflow task sent to the main agent. */
      readonly task: string;
      readonly taskTruncated?: true | undefined;
      readonly omittedTaskChars?: number | undefined;
      /** Redacted assistant/tool events retained from the start of this attempt. */
      readonly log?: ReadonlyArray<string> | undefined;
      /** Whether later events were omitted from the bounded prefix. */
      readonly logTruncated?: true | undefined;
      readonly omittedLogEvents?: number | undefined;
      readonly startedAt: number;
      readonly result?: StepAttemptResult | undefined;
      readonly gateDecision?: StepGateDecision | undefined;
    }
  | {
      readonly kind: 'subagent';
      readonly requestId: string;
      /** One-based attempt position within this step visit. */
      readonly ordinal?: number | undefined;
      readonly agent: string;
      /** Exact task body sent after the private child-policy envelope. */
      readonly task: string;
      readonly taskTruncated?: true | undefined;
      readonly omittedTaskChars?: number | undefined;
      readonly startedAt: number;
      readonly transcript?: SubagentTranscriptReference | undefined;
      readonly result?: StepAttemptResult | undefined;
      readonly gateDecision?: StepGateDecision | undefined;
    };

export type StepHistoryEntry = {
  readonly stepId: string;
  readonly stepDigest: string;
  readonly outcome: string;
  readonly summary: string;
  /** Canonical execution directory selected by this completed step. */
  readonly workspaceCwd?: string | undefined;
  /** Artifact projection paired exactly with `approval` on approved gates. */
  readonly artifact?: string | undefined;
  /** Complete approval provenance for a newly completed gate step. */
  readonly approval?: GateApproval | undefined;
  /** Durable execution evidence for every attempt of this completed step. */
  readonly attempts?: ReadonlyArray<StepExecutionAttempt> | undefined;
  /** Older attempts compacted to keep the checkpoint bounded. */
  readonly omittedAttempts?: number | undefined;
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
  /** Compact step handoff kept separate from the opaque review artifact. */
  readonly summary?: string | undefined;
  readonly submittedOutcome: string;
  readonly requestedAt: number;
  readonly reviewId?: string | undefined;
  readonly resolution?: GateResolution | undefined;
};

export type WorkflowRun = {
  readonly stateVersion: typeof RUN_STATE_VERSION;
  /** One-based attempt number within a restartable workflow/worktree lineage. */
  readonly iteration?: number | undefined;
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
  /** Attempts for the current, not-yet-completed step. */
  readonly currentStepAttempts?:
    ReadonlyArray<StepExecutionAttempt> | undefined;
  /** Older current-step attempts compacted from the checkpoint. */
  readonly currentStepOmittedAttempts?: number | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  /**
   * Most recent human-approved gate artifact. The workflow prompt decides how
   * to interpret this opaque value.
   */
  readonly reviewedArtifact?: string | undefined;
  /** Final feedback paired with the approved artifact. */
  readonly reviewedFeedback?: string | undefined;
  /** Immutable working directory captured when the workflow started. */
  readonly startCwd?: string | undefined;
  /** Current canonical execution directory for delegated workflow steps. */
  readonly cwd?: string | undefined;
  /**
   * Exact workspace that a restarted iteration must bind before it can finish.
   * This prevents a missing prior worktree from being silently replaced.
   */
  readonly restartWorkspaceCwd?: string | undefined;
  /**
   * Input inherited from the previous completed step. Unlike `lastSummary`,
   * this survives a paused attempt of the current step.
   */
  readonly stepHandoff?: string | undefined;
  readonly lastSummary: string;
  /** Opaque artifact returned by the latest rejected or failed gate. */
  readonly gateArtifact?: string | undefined;
  readonly gateFeedback: string;
  /** User-authored guidance supplied for the current resume attempt. */
  readonly resumeInput?: string | undefined;
  readonly pauseReason?: string | undefined;
  readonly pausedFrom?: 'running' | 'awaiting-gate' | undefined;
  /** Current step when execution failed and was paused for a resumable retry. */
  readonly failedStepId?: string | undefined;
  readonly pendingGate?: PendingGate | undefined;
};
