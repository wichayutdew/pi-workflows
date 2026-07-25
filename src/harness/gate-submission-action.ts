import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import {
  attachGateReviewId,
  beginGate,
  failGate,
  failRun,
  resolveGate,
} from '../engine/transitions.ts';
import { reviewedCommandShapeError } from '../policy/approved-commands.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'dependencies'
  | 'isSessionActive'
  | 'latestContext'
  | 'launchPromptReview'
  | 'persist'
  | 'pi'
  | 'restoreBaselineTools'
  | 'run'
  | 'sessionEpoch'
  | 'settleAfterTransition'
  | 'updateStatus'
>;

export type GateSubmissionAction = {
  submitGate: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    originalRun: WorkflowRun,
    outcome: string,
    artifact: string,
  ) => Promise<void>;
};

function isCurrentGateRequest(
  run: WorkflowRun | undefined,
  originalRun: WorkflowRun,
  requestId: string,
): run is WorkflowRun {
  return (
    run !== undefined &&
    run.runId === originalRun.runId &&
    run.currentStepId === originalRun.currentStepId &&
    run.pendingGate?.requestId === requestId &&
    run.pendingGate.reviewId === undefined &&
    (run.status === 'awaiting-gate' || run.status === 'paused')
  );
}

async function submitGate(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
  originalRun: WorkflowRun,
  outcome: string,
  artifact: string,
): Promise<void> {
  const requestSessionEpoch = this.sessionEpoch;
  const requestId =
    `${originalRun.runId}:${originalRun.currentStepId}:` +
    this.dependencies.createRequestId();
  const step = workflow.definition.steps[originalRun.currentStepId];
  if (!step?.gate) throw new Error('Current step has no gate');

  const commandShapeError = reviewedCommandShapeError(artifact);
  if (commandShapeError) {
    const awaitingReview = beginGate(
      workflow,
      originalRun,
      outcome,
      artifact,
      requestId,
      this.dependencies.now(),
    );
    this.run = resolveGate(
      workflow,
      awaitingReview,
      {
        approved: false,
        feedback: commandShapeError,
        resolvedAt: this.dependencies.now(),
      },
      this.dependencies.now(),
    );
    this.latestContext?.ui.notify(
      `Plan contract needs repair before review: ${commandShapeError}`,
      'warning',
    );
    this.settleAfterTransition(workflow);
    return;
  }

  this.run = beginGate(
    workflow,
    originalRun,
    outcome,
    artifact,
    requestId,
    this.dependencies.now(),
  );
  this.persist();
  this.restoreBaselineTools();
  this.updateStatus();

  if (step.gate.provider === 'prompt') {
    this.launchPromptReview(workflow, this.run, this.latestContext);
    return;
  }

  const response = await this.dependencies.requestPlannotatorReview(
    this.pi.events,
    requestId,
    artifact,
    `pi-workflows:${workflow.definition.id}:${originalRun.currentStepId}`,
    step.gate.timeoutMs,
  );
  const currentRun = this.run;
  if (
    !this.isSessionActive ||
    this.sessionEpoch !== requestSessionEpoch ||
    !isCurrentGateRequest(currentRun, originalRun, requestId)
  ) {
    throw new Error('Gate request was superseded by a workflow state change');
  }
  if (response.status !== 'handled') {
    const reason = response.error ?? 'Plannotator is unavailable';
    const gateFailed = failGate(currentRun, reason, this.dependencies.now());
    this.run = failRun(gateFailed, reason, this.dependencies.now());
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    throw new Error(reason);
  }
  this.run = attachGateReviewId(
    currentRun,
    response.result.reviewId,
    this.dependencies.now(),
  );
  this.persist();
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Submitted "${originalRun.currentStepId}" for Plannotator review ${response.result.reviewId}`,
    'info',
  );
}

/**
 * Returns the gate-submission action for harness composition.
 */
export function createGateSubmissionAction(): GateSubmissionAction {
  return { submitGate };
}
