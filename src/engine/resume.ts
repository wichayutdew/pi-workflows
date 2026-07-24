import type { WorkflowRun } from "./state.ts";

export interface ResumeCheckpoint {
  sessionEpoch: number;
  runId: string;
  workflowId: string;
  currentStepId: string;
  reviewId?: string;
}

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
 */
export function matchesResumeCheckpoint(
  run: WorkflowRun | undefined,
  sessionEpoch: number,
  checkpoint: ResumeCheckpoint,
): run is WorkflowRun {
  return (
    sessionEpoch === checkpoint.sessionEpoch &&
    run?.status === "paused" &&
    run.runId === checkpoint.runId &&
    run.workflowId === checkpoint.workflowId &&
    run.currentStepId === checkpoint.currentStepId &&
    run.pendingGate?.reviewId === checkpoint.reviewId
  );
}
