import type { WorkflowRun } from '../../domain/index.ts';

export type ResumeCheckpoint = {
  readonly sessionEpoch: number;
  readonly runId: string;
  readonly workflowId: string;
  readonly currentStepId: string;
  readonly reviewId?: string;
};

/**
 * Captures the identity fields that asynchronous resume work must preserve.
 *
 * @param run - Paused workflow run.
 * @param sessionEpoch - Current session-tree epoch.
 * @returns A checkpoint suitable for a later identity comparison.
 */
export function captureResumeCheckpoint(
  run: WorkflowRun,
  sessionEpoch: number,
): ResumeCheckpoint {
  return {
    sessionEpoch,
    runId: run.runId,
    workflowId: run.workflowId,
    currentStepId: run.currentStepId,
    ...(run.pendingGate?.reviewId
      ? { reviewId: run.pendingGate.reviewId }
      : {}),
  };
}

/**
 * Async resume work may overlap an abort, a session-tree switch, or a gate
 * result. A gate result may update the same paused checkpoint and is safe to
 * merge; a different session, run, step, review, or status is not.
 *
 * @param run - Current workflow state.
 * @param sessionEpoch - Current session-tree epoch.
 * @param checkpoint - Identity captured before asynchronous work.
 * @returns `true` when the paused run still matches the checkpoint.
 */
export function matchesResumeCheckpoint(
  run: WorkflowRun | undefined,
  sessionEpoch: number,
  checkpoint: ResumeCheckpoint,
): run is WorkflowRun {
  return (
    sessionEpoch === checkpoint.sessionEpoch &&
    run?.status === 'paused' &&
    run.runId === checkpoint.runId &&
    run.workflowId === checkpoint.workflowId &&
    run.currentStepId === checkpoint.currentStepId &&
    run.pendingGate?.reviewId === checkpoint.reviewId
  );
}
