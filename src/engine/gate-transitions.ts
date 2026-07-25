import type { LoadedWorkflow } from '../config/types.ts';
import { advanceRun } from './run-advance.ts';
import type { GateResolution, WorkflowRun } from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

/**
 * Begins human review for a gated workflow step.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current running workflow state.
 * @param outcome - Submitted gate outcome.
 * @param artifact - Artifact to display for review.
 * @param requestId - Stable gate request identifier.
 * @param now - Update timestamp.
 * @returns A new awaiting-gate workflow state.
 * @throws When the run or gate submission is invalid.
 */
export const beginGate = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  outcome: string,
  artifact: string,
  requestId: string,
  now: number,
): WorkflowRun => {
  if (run.status !== 'running') {
    throw new Error(
      `workflow is ${run.status}; gate submission requires a running workflow`,
    );
  }
  const step = currentStep(workflow, run);
  if (!step?.gate) {
    throw new Error(`step "${run.currentStepId}" has no gate`);
  }
  if (outcome !== step.gate.submitOutcome) {
    throw new Error(`gate expects outcome "${step.gate.submitOutcome}"`);
  }
  if (!artifact.trim()) {
    throw new Error('gate submission requires a non-empty artifact');
  }
  if (!requestId) throw new Error('gate submission requires a request id');

  return withRunUpdate(
    run,
    {
      status: 'awaiting-gate',
      pendingGate: {
        provider: step.gate.provider,
        requestId,
        stepId: run.currentStepId,
        artifact,
        submittedOutcome: outcome,
        requestedAt: now,
      },
    },
    now,
  );
};

/**
 * Attaches the provider review identifier to a pending Plannotator gate.
 *
 * @param run - Current workflow state.
 * @param reviewId - Provider review identifier.
 * @param now - Update timestamp.
 * @returns A new workflow state with the review identifier.
 * @throws When no Plannotator gate is pending.
 */
export const attachGateReviewId = (
  run: WorkflowRun,
  reviewId: string,
  now: number,
): WorkflowRun => {
  if (!run.pendingGate) throw new Error('workflow has no pending gate');
  if (run.pendingGate.provider !== 'plannotator') {
    throw new Error('only a Plannotator gate can have a review id');
  }
  return withRunUpdate(
    run,
    { pendingGate: { ...run.pendingGate, reviewId } },
    now,
  );
};

/**
 * Returns a failed gate request to active step execution with feedback.
 *
 * @param run - Current workflow state.
 * @param reason - Gate failure feedback.
 * @param now - Update timestamp.
 * @returns A running state, or the original state when no gate is pending.
 */
export const failGate = (
  run: WorkflowRun,
  reason: string,
  now: number,
): WorkflowRun =>
  run.pendingGate
    ? withRunUpdate(
        run,
        {
          status: 'running',
          pendingGate: undefined,
          gateFeedback: reason,
        },
        now,
      )
    : run;

/**
 * Stores a gate resolution without advancing the workflow.
 *
 * @param run - Current workflow state.
 * @param resolution - Human review resolution.
 * @param now - Update timestamp.
 * @returns Updated gate state, or the original state when no gate is pending.
 */
export const storeGateResolution = (
  run: WorkflowRun,
  resolution: GateResolution,
  now: number,
): WorkflowRun =>
  run.pendingGate
    ? withRunUpdate(
        run,
        { pendingGate: { ...run.pendingGate, resolution } },
        now,
      )
    : run;

/**
 * Applies a human gate decision and follows its configured transition.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current awaiting-gate workflow state.
 * @param resolution - Human review resolution.
 * @param now - Update timestamp.
 * @returns The workflow state after the configured gate transition.
 * @throws When pending gate state no longer matches the workflow.
 */
export const resolveGate = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  resolution: GateResolution,
  now: number,
): WorkflowRun => {
  const pendingGate = run.pendingGate;
  if (!pendingGate) throw new Error('workflow has no pending gate');

  const step = workflow.definition.steps[pendingGate.stepId];
  if (!step?.gate) {
    throw new Error(`gated step "${pendingGate.stepId}" no longer exists`);
  }
  if (run.currentStepId !== pendingGate.stepId) {
    throw new Error('gate result does not match the current step');
  }

  const outcome = resolution.approved
    ? step.gate.approvedOutcome
    : step.gate.rejectedOutcome;
  const summary = resolution.approved
    ? pendingGate.artifact
    : resolution.feedback
      ? `Gate rejected: ${resolution.feedback}`
      : 'Gate rejected';
  const runnableRun = withRunUpdate(
    run,
    {
      status: 'running',
      pendingGate: undefined,
      ...(resolution.approved
        ? { reviewedArtifact: pendingGate.artifact }
        : {}),
      pausedFrom: undefined,
      pauseReason: undefined,
      gateFeedback: resolution.feedback,
    },
    now,
  );
  return {
    ...advanceRun(workflow, runnableRun, outcome, summary, now),
    gateFeedback: resolution.feedback,
  };
};
