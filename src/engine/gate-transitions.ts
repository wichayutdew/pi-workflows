import type { LoadedWorkflow } from '../config/types.ts';
import { advanceRun } from './run-advance.ts';
import { recordCurrentGateDecision } from './step-trace.ts';
import {
  MAX_GATE_FEEDBACK_CHARS,
  type GateResolution,
  type WorkflowRun,
} from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

const GATE_FEEDBACK_TRUNCATION_SUFFIX =
  '\n… [gate feedback truncated by Pi Workflows]';
const MAX_GATE_REJECTION_SUMMARY_CHARS = 500;

const boundedGateFeedback = (feedback: string): string =>
  feedback.length <= MAX_GATE_FEEDBACK_CHARS
    ? feedback
    : `${feedback.slice(
        0,
        MAX_GATE_FEEDBACK_CHARS - GATE_FEEDBACK_TRUNCATION_SUFFIX.length,
      )}${GATE_FEEDBACK_TRUNCATION_SUFFIX}`;

const gateRejectionSummary = (feedback: string): string => {
  const compact = feedback.trim().replace(/\s+/g, ' ');
  if (!compact) return 'Gate rejected';
  const summary = `Gate rejected: ${compact}`;
  return summary.length <= MAX_GATE_REJECTION_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, MAX_GATE_REJECTION_SUMMARY_CHARS - 1)}…`;
};

/**
 * Begins human review for a gated workflow step.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current running workflow state.
 * @param outcome - Submitted gate outcome.
 * @param artifact - Artifact to display for review.
 * @param requestId - Stable gate request identifier.
 * @param now - Update timestamp.
 * @param summary - Compact step handoff, separate from the review artifact.
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
  summary: string,
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
  if (!summary.trim()) {
    throw new Error('gate submission requires a non-empty summary');
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
        summary,
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
): WorkflowRun => {
  if (!run.pendingGate) return run;
  return withRunUpdate(
    run,
    {
      status: 'running',
      pendingGate: undefined,
      gateArtifact: run.pendingGate.artifact,
      gateFeedback: boundedGateFeedback(reason),
      pausedFrom: undefined,
      pauseReason: undefined,
      failedStepId: undefined,
    },
    now,
  );
};

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
): WorkflowRun => {
  if (!run.pendingGate) return run;
  return withRunUpdate(
    run,
    {
      pendingGate: {
        ...run.pendingGate,
        resolution: {
          ...resolution,
          feedback: boundedGateFeedback(resolution.feedback),
        },
      },
    },
    now,
  );
};

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
  const feedback = boundedGateFeedback(resolution.feedback);
  const stepStructuralDigest =
    workflow.stepStructuralDigests[pendingGate.stepId] ?? '';
  if (resolution.approved && !stepStructuralDigest) {
    throw new Error(
      `gated step "${pendingGate.stepId}" has no structural digest`,
    );
  }
  const summary = resolution.approved
    ? (pendingGate.summary ?? '')
    : gateRejectionSummary(feedback);
  const decidedRun = recordCurrentGateDecision(
    run,
    {
      provider: pendingGate.provider,
      requestId: pendingGate.requestId,
      approved: resolution.approved,
      feedback,
      resolvedAt: resolution.resolvedAt,
      ...(pendingGate.reviewId ? { reviewId: pendingGate.reviewId } : {}),
    },
    now,
  );
  const runnableRun = withRunUpdate(
    decidedRun,
    {
      status: 'running',
      pendingGate: undefined,
      pausedFrom: undefined,
      pauseReason: undefined,
      gateArtifact: resolution.approved ? '' : pendingGate.artifact,
      gateFeedback: resolution.approved ? '' : feedback,
    },
    now,
  );
  const isSameStepHumanRevision =
    !resolution.approved && step.transitions[outcome] === pendingGate.stepId;
  const advanced = advanceRun(
    workflow,
    runnableRun,
    outcome,
    summary,
    now,
    {},
    {
      sameStepHumanGateRevision: isSameStepHumanRevision,
    },
  );
  const completedApprovedGate =
    resolution.approved && advanced.history.length > runnableRun.history.length;
  const history = completedApprovedGate
    ? advanced.history.map((entry, index) =>
        index === advanced.history.length - 1
          ? {
              ...entry,
              artifact: pendingGate.artifact,
              approval: {
                requestId: pendingGate.requestId,
                artifact: pendingGate.artifact,
                feedback,
                stepStructuralDigest,
              },
            }
          : entry,
      )
    : advanced.history;
  return {
    ...advanced,
    history,
    ...(completedApprovedGate
      ? {
          reviewedArtifact: pendingGate.artifact,
          reviewedFeedback: feedback,
        }
      : {}),
    gateArtifact: resolution.approved ? '' : pendingGate.artifact,
    gateFeedback: resolution.approved ? '' : feedback,
  };
};
