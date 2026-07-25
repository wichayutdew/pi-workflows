import {
  RUN_STATE_VERSION,
  type GateResolution,
  type PendingGate,
  type StepHistoryEntry,
  type WorkflowRun,
  type WorkflowRunStatus,
} from './state-types.ts';

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStepHistoryEntry = (value: unknown): value is StepHistoryEntry =>
  isRecord(value) &&
  typeof value.stepId === 'string' &&
  typeof value.stepDigest === 'string' &&
  typeof value.outcome === 'string' &&
  typeof value.summary === 'string' &&
  typeof value.completedAt === 'number';

const isGateResolution = (value: unknown): value is GateResolution =>
  isRecord(value) &&
  typeof value.approved === 'boolean' &&
  typeof value.feedback === 'string' &&
  typeof value.resolvedAt === 'number';

const isPendingGate = (value: unknown): value is PendingGate =>
  isRecord(value) &&
  (value.provider === 'prompt' || value.provider === 'plannotator') &&
  typeof value.requestId === 'string' &&
  value.requestId.length > 0 &&
  typeof value.stepId === 'string' &&
  typeof value.artifact === 'string' &&
  (value.summary === undefined || typeof value.summary === 'string') &&
  typeof value.submittedOutcome === 'string' &&
  typeof value.requestedAt === 'number' &&
  (value.reviewId === undefined || typeof value.reviewId === 'string') &&
  (value.resolution === undefined || isGateResolution(value.resolution));

const isVisitCounts = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.values(value).every(
    (count) =>
      typeof count === 'number' && Number.isInteger(count) && count >= 0,
  );

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const isWorkflowRunStatus = (value: unknown): value is WorkflowRunStatus =>
  value === 'running' ||
  value === 'paused' ||
  value === 'awaiting-gate' ||
  value === 'completed' ||
  value === 'aborted';

const hasValidPauseState = (run: UnknownRecord): boolean =>
  run.status === 'paused'
    ? run.pausedFrom === 'running' || run.pausedFrom === 'awaiting-gate'
    : run.pausedFrom === undefined;

const hasValidFailureState = (run: UnknownRecord): boolean =>
  run.failedStepId === undefined ||
  (run.status === 'paused' && run.failedStepId === run.currentStepId);

const hasValidGateState = (
  run: UnknownRecord,
  pendingGate: PendingGate | undefined,
): boolean =>
  pendingGate === undefined
    ? run.status !== 'awaiting-gate' && run.pausedFrom !== 'awaiting-gate'
    : pendingGate.stepId === run.currentStepId &&
      (run.status === 'awaiting-gate' ||
        (run.status === 'paused' && run.pausedFrom === 'awaiting-gate'));

/**
 * Validates an unknown value as a persisted workflow run.
 *
 * State invariants are checked in addition to field types so corrupt
 * checkpoints cannot resume into an impossible gate, pause, or failure state.
 *
 * @param value - Persisted value to validate.
 * @returns `true` when the value is a valid workflow run.
 */
export const isWorkflowRun = (value: unknown): value is WorkflowRun => {
  if (!isRecord(value)) return false;

  const hasValidRequiredFields =
    value.stateVersion === RUN_STATE_VERSION &&
    typeof value.runId === 'string' &&
    typeof value.workflowId === 'string' &&
    typeof value.workflowDigest === 'string' &&
    typeof value.input === 'string' &&
    isWorkflowRunStatus(value.status) &&
    typeof value.currentStepId === 'string' &&
    typeof value.currentStepDigest === 'string' &&
    Array.isArray(value.baselineTools) &&
    value.baselineTools.every((tool) => typeof tool === 'string') &&
    Array.isArray(value.history) &&
    value.history.every(isStepHistoryEntry) &&
    isVisitCounts(value.visits) &&
    typeof value.startedAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastSummary === 'string' &&
    typeof value.gateFeedback === 'string';
  if (!hasValidRequiredFields) return false;

  const hasValidOptionalFields =
    isOptionalString(value.reviewedArtifact) &&
    isOptionalString(value.stepHandoff) &&
    isOptionalString(value.pauseReason) &&
    isOptionalString(value.failedStepId) &&
    (value.pausedFrom === undefined ||
      value.pausedFrom === 'running' ||
      value.pausedFrom === 'awaiting-gate');
  if (!hasValidOptionalFields) return false;

  const pendingGate = value.pendingGate;
  if (pendingGate !== undefined && !isPendingGate(pendingGate)) return false;

  return (
    hasValidPauseState(value) &&
    hasValidFailureState(value) &&
    hasValidGateState(value, pendingGate)
  );
};
