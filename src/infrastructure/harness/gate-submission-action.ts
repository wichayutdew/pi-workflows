import type { LoadedWorkflow } from '../../domain/index.ts';
import type { WorkflowRun } from '../../domain/index.ts';
import { validateArtifactContract } from '../../function/index.ts';
import {
  advanceRun,
  attachGateReviewId,
  beginGate,
  failGate,
  failRun,
} from '../../function/index.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { reportFailedStep } from './step-reporting.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'dependencies'
  | 'isSessionActive'
  | 'latestContext'
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
    summary: string,
    artifact: string,
  ) => Promise<void>;
};

function recoverableArtifactContractFeedback(
  contractError: string,
): string | undefined {
  if (
    !contractError.startsWith('gate artifact is missing required heading:') &&
    !contractError.startsWith('gate artifact exceeds ')
  ) {
    return undefined;
  }
  return `${contractError}; regenerate the complete artifact more concisely under the configured limit`;
}

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
  summary: string,
  artifact: string,
): Promise<void> {
  const requestSessionEpoch = this.sessionEpoch;
  const requestId =
    `${originalRun.runId}:${originalRun.currentStepId}:` +
    this.dependencies.createRequestId();
  const step = workflow.definition.steps[originalRun.currentStepId];
  if (!step?.gate) throw new Error('Current step has no gate');
  const contractError = validateArtifactContract(
    artifact,
    step.gate.artifactContract,
  );
  if (contractError) {
    const feedback = recoverableArtifactContractFeedback(contractError);
    if (!feedback) throw new Error(contractError);
    const now = this.dependencies.now();
    const failedGate = failGate(
      beginGate(
        workflow,
        originalRun,
        outcome,
        artifact,
        requestId,
        now,
        summary,
      ),
      feedback,
      now,
    );
    this.run = advanceRun(
      workflow,
      failedGate,
      step.gate.rejectedOutcome,
      feedback,
      now,
      {},
      { sameStepHumanGateRevision: true },
    );
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    this.settleAfterTransition(workflow, {
      stepId: originalRun.currentStepId,
      outcome: step.gate.rejectedOutcome,
      summary: feedback,
    });
    return;
  }

  this.run = beginGate(
    workflow,
    originalRun,
    outcome,
    artifact,
    requestId,
    this.dependencies.now(),
    summary,
  );
  this.persist();
  this.restoreBaselineTools();
  this.updateStatus();

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
    reportFailedStep(this.pi, workflow, this.run, reason);
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
