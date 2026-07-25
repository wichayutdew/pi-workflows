import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  failGate,
  failRun,
  reconcileRun,
  resolveGate,
  resumeRun,
  storeGateResolution,
} from '../engine/transitions.ts';
import {
  captureResumeCheckpoint,
  matchesResumeCheckpoint,
} from '../engine/resume.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'captureSkills'
  | 'catalog'
  | 'dependencies'
  | 'isolateMainSessionTools'
  | 'launchCurrentStep'
  | 'launchPromptReview'
  | 'persist'
  | 'pi'
  | 'preflight'
  | 'reloadCatalog'
  | 'restoreBaselineTools'
  | 'run'
  | 'sessionEpoch'
  | 'updateStatus'
>;

export type ResumeAction = {
  resumeNow: (
    this: HarnessActionContext,
    context: ExtensionCommandContext,
  ) => Promise<void>;
};

async function resumeNow(
  this: HarnessActionContext,
  context: ExtensionCommandContext,
): Promise<void> {
  if (!this.run || this.run.status !== 'paused') {
    context.ui.notify('No paused workflow to resume', 'warning');
    return;
  }
  if (this.activeDelegation) {
    context.ui.notify(
      `Cannot resume while subagent "${this.activeDelegation.agent}" is still cancelling`,
      'warning',
    );
    return;
  }
  const checkpoint = captureResumeCheckpoint(this.run, this.sessionEpoch);
  if (!context.isIdle()) {
    context.abort();
    await context.waitForIdle();
  }
  if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
    context.ui.notify(
      'Resume was superseded by another workflow or session change',
      'warning',
    );
    return;
  }
  this.captureSkills(context.getSystemPromptOptions().skills);
  await this.reloadCatalog(context, false);
  if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
    context.ui.notify(
      'Resume was superseded by another workflow or session change',
      'warning',
    );
    return;
  }

  let workflow = this.catalog.workflows.get(this.run.workflowId);
  if (!workflow) {
    context.ui.notify(
      `Workflow "${this.run.workflowId}" is no longer loaded; restore it or abort`,
      'error',
    );
    return;
  }
  const reconciled = reconcileRun(this.run, workflow, this.dependencies.now());
  if (!reconciled.run) {
    context.ui.notify(
      reconciled.error ?? 'Cannot reconcile workflow configuration',
      'error',
    );
    return;
  }

  let resumed = reconciled.run;
  if (
    resumed.pendingGate?.provider === 'plannotator' &&
    !resumed.pendingGate.reviewId
  ) {
    resumed = failGate(
      resumed,
      'Gate submission was interrupted before a review id was recorded; submit it again',
      this.dependencies.now(),
    );
  }
  if (
    resumed.pendingGate?.provider === 'plannotator' &&
    resumed.pendingGate.reviewId &&
    !resumed.pendingGate.resolution
  ) {
    const requestedReviewId = resumed.pendingGate.reviewId;
    const gateStep = workflow.definition.steps[resumed.pendingGate.stepId];
    const statusResponse =
      await this.dependencies.requestPlannotatorReviewStatus(
        this.pi.events,
        `${resumed.runId}:review-status:${this.dependencies.createRequestId()}`,
        requestedReviewId,
        gateStep?.gate?.provider === 'plannotator'
          ? gateStep.gate.timeoutMs
          : 5_000,
      );
    if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
      context.ui.notify(
        'Resume was superseded by another workflow or session change',
        'warning',
      );
      return;
    }

    workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) {
      context.ui.notify(
        `Workflow "${this.run.workflowId}" is no longer loaded; restore it or abort`,
        'error',
      );
      return;
    }
    const latest = reconcileRun(this.run, workflow, this.dependencies.now());
    if (!latest.run) {
      context.ui.notify(
        latest.error ?? 'Cannot reconcile workflow configuration',
        'error',
      );
      return;
    }
    resumed = latest.run;

    if (
      !resumed.pendingGate?.resolution &&
      resumed.pendingGate?.reviewId === requestedReviewId &&
      statusResponse.status !== 'handled'
    ) {
      context.ui.notify(
        statusResponse.error ?? 'Cannot query the pending Plannotator review',
        'error',
      );
      return;
    }
    if (
      !resumed.pendingGate?.resolution &&
      resumed.pendingGate?.reviewId === requestedReviewId &&
      statusResponse.status === 'handled' &&
      statusResponse.result.status === 'completed'
    ) {
      resumed = storeGateResolution(
        resumed,
        {
          approved: statusResponse.result.approved,
          feedback: statusResponse.result.feedback,
          resolvedAt: this.dependencies.now(),
        },
        this.dependencies.now(),
      );
    } else if (
      !resumed.pendingGate?.resolution &&
      resumed.pendingGate?.reviewId === requestedReviewId &&
      statusResponse.status === 'handled' &&
      statusResponse.result.status === 'missing'
    ) {
      resumed = failGate(
        resumed,
        'Plannotator no longer has the pending review; submit it again',
        this.dependencies.now(),
      );
    }
  }

  const storedResolution = resumed.pendingGate?.resolution;
  if (storedResolution) {
    try {
      resumed = resolveGate(
        workflow,
        resumed,
        storedResolution,
        this.dependencies.now(),
      );
    } catch (error) {
      context.ui.notify(
        `Cannot apply stored gate result: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return;
    }
  } else {
    resumed = resumeRun(resumed, this.dependencies.now());
  }
  this.run = resumed;

  if (this.run.status === 'awaiting-gate') {
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    if (this.run.pendingGate?.provider === 'prompt') {
      this.launchPromptReview(workflow, this.run, context);
      context.ui.notify('Workflow resumed with built-in review open', 'info');
      return;
    }
    context.ui.notify(
      `Workflow resumed and is waiting for review ${this.run.pendingGate?.reviewId ?? ''}`.trim(),
      'info',
    );
    return;
  }
  if (this.run.status !== 'running') {
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    context.ui.notify(`Workflow is now ${this.run.status}`, 'info');
    return;
  }

  const preflightErrors = this.preflight(workflow, this.run.currentStepId);
  if (preflightErrors.length > 0) {
    this.run = failRun(
      this.run,
      `Step preflight failed: ${preflightErrors.join('; ')}`,
      this.dependencies.now(),
    );
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    context.ui.notify(
      `Cannot resume workflow:\n${preflightErrors.join('\n')}`,
      'error',
    );
    return;
  }

  this.persist();
  this.isolateMainSessionTools();
  this.updateStatus();
  this.launchCurrentStep(workflow);
}

/**
 * Returns the resume action for harness composition.
 */
export function createResumeAction(): ResumeAction {
  return { resumeNow };
}
