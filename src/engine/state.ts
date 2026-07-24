import type { LoadedWorkflow } from '../config/types.ts';

export const RUN_STATE_VERSION = 1 as const;

export type WorkflowRunStatus =
  'running' | 'paused' | 'awaiting-gate' | 'completed' | 'aborted';

export interface StepHistoryEntry {
  stepId: string;
  stepDigest: string;
  outcome: string;
  summary: string;
  completedAt: number;
}

export interface GateResolution {
  approved: boolean;
  feedback: string;
  resolvedAt: number;
}

export interface PendingGate {
  provider: 'prompt' | 'plannotator';
  requestId: string;
  stepId: string;
  artifact: string;
  /** Legacy v1 field. New runs use the reviewed artifact as the handoff. */
  summary?: string | undefined;
  submittedOutcome: string;
  requestedAt: number;
  reviewId?: string | undefined;
  resolution?: GateResolution | undefined;
}

export interface WorkflowRun {
  stateVersion: typeof RUN_STATE_VERSION;
  runId: string;
  workflowId: string;
  workflowDigest: string;
  input: string;
  status: WorkflowRunStatus;
  currentStepId: string;
  currentStepDigest: string;
  baselineTools: string[];
  visits: Record<string, number>;
  history: StepHistoryEntry[];
  startedAt: number;
  updatedAt: number;
  /**
   * Most recent human-approved gate artifact. This is the only provenance
   * source from which reviewed Bash capabilities may be derived.
   */
  reviewedArtifact?: string | undefined;
  /**
   * Input inherited from the previous completed step. Unlike `lastSummary`,
   * this survives a paused attempt of the current step.
   */
  stepHandoff?: string | undefined;
  lastSummary: string;
  gateFeedback: string;
  pauseReason?: string | undefined;
  pausedFrom?: 'running' | 'awaiting-gate' | undefined;
  pendingGate?: PendingGate | undefined;
}

export function createRun(
  workflow: LoadedWorkflow,
  input: string,
  baselineTools: string[],
  runId: string,
  now: number,
): WorkflowRun {
  const start = workflow.definition.start;
  return {
    stateVersion: RUN_STATE_VERSION,
    runId,
    workflowId: workflow.definition.id,
    workflowDigest: workflow.digest,
    input,
    status: 'running',
    currentStepId: start,
    currentStepDigest: workflow.stepDigests[start] ?? '',
    baselineTools: [...new Set(baselineTools)],
    visits: { [start]: 1 },
    history: [],
    startedAt: now,
    updatedAt: now,
    reviewedArtifact: '',
    stepHandoff: '',
    lastSummary: '',
    gateFeedback: '',
  };
}

export function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (value === null || typeof value !== 'object') return false;
  const run = value as Partial<WorkflowRun>;
  const historyIsValid =
    Array.isArray(run.history) &&
    run.history.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.stepId === 'string' &&
        typeof entry.stepDigest === 'string' &&
        typeof entry.outcome === 'string' &&
        typeof entry.summary === 'string' &&
        typeof entry.completedAt === 'number',
    );
  const visitsAreValid =
    run.visits !== null &&
    typeof run.visits === 'object' &&
    !Array.isArray(run.visits) &&
    Object.values(run.visits).every(
      (count) => Number.isInteger(count) && count >= 0,
    );
  const gateIsValid =
    run.pendingGate === undefined ||
    (run.pendingGate !== null &&
      typeof run.pendingGate === 'object' &&
      (run.pendingGate.provider === 'prompt' ||
        run.pendingGate.provider === 'plannotator') &&
      typeof run.pendingGate.requestId === 'string' &&
      run.pendingGate.requestId.length > 0 &&
      typeof run.pendingGate.stepId === 'string' &&
      typeof run.pendingGate.artifact === 'string' &&
      (run.pendingGate.summary === undefined ||
        typeof run.pendingGate.summary === 'string') &&
      typeof run.pendingGate.submittedOutcome === 'string' &&
      typeof run.pendingGate.requestedAt === 'number' &&
      (run.pendingGate.reviewId === undefined ||
        typeof run.pendingGate.reviewId === 'string') &&
      (run.pendingGate.resolution === undefined ||
        (run.pendingGate.resolution !== null &&
          typeof run.pendingGate.resolution === 'object' &&
          typeof run.pendingGate.resolution.approved === 'boolean' &&
          typeof run.pendingGate.resolution.feedback === 'string' &&
          typeof run.pendingGate.resolution.resolvedAt === 'number')));
  const optionalsAreValid =
    (run.reviewedArtifact === undefined ||
      typeof run.reviewedArtifact === 'string') &&
    (run.stepHandoff === undefined || typeof run.stepHandoff === 'string') &&
    (run.pauseReason === undefined || typeof run.pauseReason === 'string') &&
    (run.pausedFrom === undefined ||
      run.pausedFrom === 'running' ||
      run.pausedFrom === 'awaiting-gate');
  const statusIsValid =
    run.status === 'running' ||
    run.status === 'paused' ||
    run.status === 'awaiting-gate' ||
    run.status === 'completed' ||
    run.status === 'aborted';
  const pauseStateIsValid =
    run.status === 'paused'
      ? run.pausedFrom === 'running' || run.pausedFrom === 'awaiting-gate'
      : run.pausedFrom === undefined;
  const gateStateIsValid = !gateIsValid
    ? false
    : run.pendingGate === undefined
      ? run.status !== 'awaiting-gate' && run.pausedFrom !== 'awaiting-gate'
      : run.pendingGate.stepId === run.currentStepId &&
        (run.status === 'awaiting-gate' ||
          (run.status === 'paused' && run.pausedFrom === 'awaiting-gate'));
  return (
    run.stateVersion === RUN_STATE_VERSION &&
    typeof run.runId === 'string' &&
    typeof run.workflowId === 'string' &&
    typeof run.workflowDigest === 'string' &&
    typeof run.input === 'string' &&
    typeof run.currentStepId === 'string' &&
    typeof run.currentStepDigest === 'string' &&
    Array.isArray(run.baselineTools) &&
    run.baselineTools.every((tool) => typeof tool === 'string') &&
    historyIsValid &&
    visitsAreValid &&
    gateIsValid &&
    optionalsAreValid &&
    statusIsValid &&
    pauseStateIsValid &&
    gateStateIsValid &&
    typeof run.startedAt === 'number' &&
    typeof run.updatedAt === 'number' &&
    typeof run.lastSummary === 'string' &&
    typeof run.gateFeedback === 'string'
  );
}
