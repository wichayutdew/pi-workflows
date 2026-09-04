import { isAbsolute, resolve } from 'node:path';
import type {
  GateApproval,
  GateResolution,
  PendingGate,
  StepAttemptResult,
  StepExecutionAttempt,
  StepGateDecision,
  StepHistoryEntry,
  UsageAggregate,
  WorkflowRun,
  WorkflowRunStatus,
} from '../../domain/index.ts';
import {
  MAX_GATE_FEEDBACK_CHARS,
  MAX_RESUME_INPUT_CHARS,
  MAX_STEP_TRACE_ARTIFACT_CHARS,
  MAX_STEP_TRACE_ATTEMPTS,
  MAX_STEP_TRACE_LOG_CHARS,
  MAX_STEP_TRACE_LOG_EVENT_CHARS,
  MAX_STEP_TRACE_LOG_EVENTS,
  MAX_STEP_TRACE_SUMMARY_CHARS,
  MAX_STEP_TRACE_TASK_CHARS,
  MAX_WORKFLOW_TRACE_CHARS,
  RUN_STATE_VERSION,
} from '../../domain/index.ts';
import { workflowTraceChars } from './step-trace.ts';
import { emptyUsageAggregate, isUsageAggregate, mergeUsage } from './usage.ts';

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAbsoluteCwd = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  isAbsolute(value) &&
  !value.includes('\0');

const isGateApproval = (value: unknown): value is GateApproval =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  value.requestId.length > 0 &&
  typeof value.artifact === 'string' &&
  value.artifact.trim().length > 0 &&
  typeof value.feedback === 'string' &&
  value.feedback.length <= MAX_GATE_FEEDBACK_CHARS &&
  typeof value.stepStructuralDigest === 'string' &&
  value.stepStructuralDigest.length > 0;

const isStepAttemptResult = (value: unknown): value is StepAttemptResult =>
  isRecord(value) &&
  typeof value.outcome === 'string' &&
  typeof value.summary === 'string' &&
  value.summary.length <= MAX_STEP_TRACE_SUMMARY_CHARS &&
  (value.summaryTruncated === undefined || value.summaryTruncated === true) &&
  (value.artifact === undefined || typeof value.artifact === 'string') &&
  (typeof value.artifact !== 'string' ||
    value.artifact.length <= MAX_STEP_TRACE_ARTIFACT_CHARS) &&
  (value.artifactTruncated === undefined || value.artifactTruncated === true) &&
  !(value.artifactTruncated === true && value.artifact === undefined) &&
  (value.workspaceCwd === undefined || isAbsoluteCwd(value.workspaceCwd));

const isStepGateDecision = (value: unknown): value is StepGateDecision =>
  isRecord(value) &&
  (value.provider === 'prompt' || value.provider === 'plannotator') &&
  typeof value.requestId === 'string' &&
  value.requestId.length > 0 &&
  typeof value.approved === 'boolean' &&
  typeof value.feedback === 'string' &&
  value.feedback.length <= MAX_STEP_TRACE_SUMMARY_CHARS &&
  (value.feedbackTruncated === undefined || value.feedbackTruncated === true) &&
  typeof value.resolvedAt === 'number' &&
  (value.reviewId === undefined || typeof value.reviewId === 'string');

const isSafeTraceIdentityField = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\0') &&
  !value.includes('/') &&
  !value.includes('\\') &&
  value !== '.' &&
  value !== '..';

const hasValidMainStepLog = (value: UnknownRecord): boolean => {
  const log = value.log;
  if (
    log !== undefined &&
    (!Array.isArray(log) ||
      log.length > MAX_STEP_TRACE_LOG_EVENTS ||
      !log.every(
        (line) =>
          typeof line === 'string' &&
          line.length > 0 &&
          line.length <= MAX_STEP_TRACE_LOG_EVENT_CHARS,
      ) ||
      log.reduce<number>(
        (total, line) => total + (typeof line === 'string' ? line.length : 0),
        0,
      ) > MAX_STEP_TRACE_LOG_CHARS)
  ) {
    return false;
  }
  if (value.logTruncated !== undefined && value.logTruncated !== true) {
    return false;
  }
  if (
    value.omittedLogEvents !== undefined &&
    (!Number.isSafeInteger(value.omittedLogEvents) ||
      (value.omittedLogEvents as number) <= 0)
  ) {
    return false;
  }
  return (
    (value.logTruncated === true) ===
      (typeof value.omittedLogEvents === 'number') &&
    !(
      log === undefined &&
      (value.logTruncated !== undefined || value.omittedLogEvents !== undefined)
    )
  );
};

const isStepExecutionAttempt = (
  value: unknown,
): value is StepExecutionAttempt => {
  if (
    !isRecord(value) ||
    (value.kind !== 'main' && value.kind !== 'subagent') ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.includes('\0') ||
    (value.ordinal !== undefined &&
      (!Number.isSafeInteger(value.ordinal) ||
        (value.ordinal as number) <= 0)) ||
    typeof value.task !== 'string' ||
    value.task.trim().length === 0 ||
    value.task.length > MAX_STEP_TRACE_TASK_CHARS ||
    (value.taskTruncated !== undefined && value.taskTruncated !== true) ||
    (value.omittedTaskChars !== undefined &&
      (!Number.isSafeInteger(value.omittedTaskChars) ||
        (value.omittedTaskChars as number) <= 0)) ||
    (value.taskTruncated === true) !==
      (typeof value.omittedTaskChars === 'number') ||
    typeof value.startedAt !== 'number' ||
    (value.usage !== undefined && !isUsageAggregate(value.usage)) ||
    (value.result !== undefined && !isStepAttemptResult(value.result)) ||
    (value.gateDecision !== undefined &&
      !isStepGateDecision(value.gateDecision))
  ) {
    return false;
  }
  if (value.kind === 'main') {
    return (
      value.agent === undefined &&
      value.transcript === undefined &&
      hasValidMainStepLog(value)
    );
  }
  if (
    value.log !== undefined ||
    value.logTruncated !== undefined ||
    value.omittedLogEvents !== undefined
  ) {
    return false;
  }
  if (typeof value.agent !== 'string' || value.agent.length === 0) {
    return false;
  }
  if (value.transcript === undefined) return true;
  if (!isRecord(value.transcript)) return false;
  const transcript = value.transcript;
  if (
    !isAbsoluteCwd(transcript.trustedRoot) ||
    !isAbsoluteCwd(transcript.sessionFile) ||
    !isSafeTraceIdentityField(transcript.runId) ||
    !Number.isSafeInteger(transcript.childIndex) ||
    (transcript.childIndex as number) < 0
  ) {
    return false;
  }
  return (
    resolve(
      transcript.trustedRoot,
      transcript.runId,
      `run-${String(transcript.childIndex)}`,
      'session.jsonl',
    ) === resolve(transcript.sessionFile)
  );
};

const isStepExecutionAttempts = (
  value: unknown,
): value is ReadonlyArray<StepExecutionAttempt> =>
  Array.isArray(value) &&
  value.length <= MAX_STEP_TRACE_ATTEMPTS &&
  value.every(isStepExecutionAttempt) &&
  new Set(value.map((attempt) => attempt.requestId)).size === value.length &&
  value.every((attempt, index) => {
    if (attempt.ordinal === undefined) return true;
    const ordinal = attempt.ordinal;
    return value
      .slice(0, index)
      .every(
        (earlier) => earlier.ordinal === undefined || earlier.ordinal < ordinal,
      );
  });

const usageMatchesAttempts = (
  attempts: ReadonlyArray<StepExecutionAttempt> | undefined,
  aggregate: UsageAggregate | undefined,
  omittedAttempts: unknown,
): boolean => {
  if (!aggregate || omittedAttempts !== undefined) return true;
  const fromAttempts = (attempts ?? []).reduce(
    (total, attempt) =>
      attempt.usage ? mergeUsage(total, attempt.usage.models) : total,
    emptyUsageAggregate(),
  );
  return JSON.stringify(fromAttempts) === JSON.stringify(aggregate);
};

const isStepHistoryEntry = (value: unknown): value is StepHistoryEntry =>
  isRecord(value) &&
  typeof value.stepId === 'string' &&
  typeof value.stepDigest === 'string' &&
  typeof value.outcome === 'string' &&
  typeof value.summary === 'string' &&
  (value.workspaceCwd === undefined || isAbsoluteCwd(value.workspaceCwd)) &&
  (value.artifact === undefined || typeof value.artifact === 'string') &&
  (value.approval === undefined ||
    (isGateApproval(value.approval) &&
      value.artifact === value.approval.artifact)) &&
  (value.attempts === undefined || isStepExecutionAttempts(value.attempts)) &&
  (value.omittedAttempts === undefined ||
    (typeof value.omittedAttempts === 'number' &&
      Number.isSafeInteger(value.omittedAttempts) &&
      value.omittedAttempts > 0)) &&
  (value.usage === undefined || isUsageAggregate(value.usage)) &&
  usageMatchesAttempts(value.attempts, value.usage, value.omittedAttempts) &&
  typeof value.completedAt === 'number';

const isGateResolution = (value: unknown): value is GateResolution =>
  isRecord(value) &&
  typeof value.approved === 'boolean' &&
  typeof value.feedback === 'string' &&
  value.feedback.length <= MAX_GATE_FEEDBACK_CHARS &&
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

const isOptionalResumeInput = (value: unknown): value is string | undefined =>
  value === undefined ||
  (typeof value === 'string' && value.length <= MAX_RESUME_INPUT_CHARS);

const isOptionalIteration = (value: unknown): value is number | undefined =>
  value === undefined ||
  (Number.isSafeInteger(value) && (value as number) >= 1);

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

const hasValidWorkspaceState = (
  run: UnknownRecord,
  history: ReadonlyArray<StepHistoryEntry>,
): boolean => {
  const startCwd = run.startCwd;
  const cwd = run.cwd;
  if (startCwd !== undefined && !isAbsoluteCwd(startCwd)) return false;
  if (cwd !== undefined && !isAbsoluteCwd(cwd)) return false;

  const bindings = history.flatMap((entry) =>
    entry.workspaceCwd ? [entry.workspaceCwd] : [],
  );
  if (new Set(bindings).size > 1) return false;
  const boundCwd = bindings.at(-1);
  if (boundCwd !== undefined) {
    return isAbsoluteCwd(startCwd) && isAbsoluteCwd(cwd) && cwd === boundCwd;
  }

  // Legacy checkpoints have only `cwd`; new checkpoints keep start/current
  // equal until a structured workspace binding is accepted.
  return startCwd === undefined || cwd === startCwd;
};

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
    (value.currentStepAttempts === undefined ||
      isStepExecutionAttempts(value.currentStepAttempts)) &&
    (value.currentStepOmittedAttempts === undefined ||
      (Number.isSafeInteger(value.currentStepOmittedAttempts) &&
        (value.currentStepOmittedAttempts as number) > 0)) &&
    (value.currentStepUsage === undefined ||
      isUsageAggregate(value.currentStepUsage)) &&
    isVisitCounts(value.visits) &&
    typeof value.startedAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastSummary === 'string' &&
    typeof value.gateFeedback === 'string' &&
    value.gateFeedback.length <= MAX_GATE_FEEDBACK_CHARS;
  if (!hasValidRequiredFields) return false;

  const hasValidOptionalFields =
    isOptionalIteration(value.iteration) &&
    isOptionalString(value.reviewedArtifact) &&
    isOptionalString(value.reviewedFeedback) &&
    (typeof value.reviewedFeedback !== 'string' ||
      value.reviewedFeedback.length <= MAX_GATE_FEEDBACK_CHARS) &&
    isOptionalString(value.stepHandoff) &&
    isOptionalString(value.gateArtifact) &&
    (value.restartWorkspaceCwd === undefined ||
      isAbsoluteCwd(value.restartWorkspaceCwd)) &&
    isOptionalResumeInput(value.resumeInput) &&
    isOptionalString(value.pauseReason) &&
    isOptionalString(value.failedStepId) &&
    (value.pausedFrom === undefined ||
      value.pausedFrom === 'running' ||
      value.pausedFrom === 'awaiting-gate');
  if (!hasValidOptionalFields) return false;

  if (
    !usageMatchesAttempts(
      value.currentStepAttempts as
        ReadonlyArray<StepExecutionAttempt> | undefined,
      value.currentStepUsage as UsageAggregate | undefined,
      value.currentStepOmittedAttempts,
    )
  )
    return false;

  const pendingGate = value.pendingGate;
  if (pendingGate !== undefined && !isPendingGate(pendingGate)) return false;

  if (
    value.restartWorkspaceCwd !== undefined &&
    (value.history as ReadonlyArray<StepHistoryEntry>).some(
      (entry) => entry.workspaceCwd !== undefined,
    )
  ) {
    return false;
  }

  return (
    workflowTraceChars(value as WorkflowRun) <= MAX_WORKFLOW_TRACE_CHARS &&
    hasValidWorkspaceState(
      value,
      value.history as ReadonlyArray<StepHistoryEntry>,
    ) &&
    hasValidPauseState(value) &&
    hasValidFailureState(value) &&
    hasValidGateState(value, pendingGate)
  );
};
