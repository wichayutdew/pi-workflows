import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow } from '../../domain/index.ts';
import type { GateResolution, WorkflowRun } from '../../domain/index.ts';
import {
  failRun,
  pauseRun,
  resolveGate,
  storeGateResolution,
} from '../../function/index.ts';
import type { PromptGateReviewResult } from '../integrations/prompt-gate.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import {
  conciseStepFailureSummary,
  conciseStepPauseSummary,
  reportFailedStep,
  reportPausedStep,
} from './step-reporting.ts';
import type { ActivePromptReview } from './types.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activePromptReview'
  | 'cancelPromptReview'
  | 'catalog'
  | 'dependencies'
  | 'finishPromptReview'
  | 'isSessionActive'
  | 'latestContext'
  | 'mutationQueue'
  | 'pausePromptGate'
  | 'persist'
  | 'pi'
  | 'queuePromptReviewFailure'
  | 'queuePromptReviewResult'
  | 'restoreBaselineTools'
  | 'run'
  | 'sessionEpoch'
  | 'settleAfterTransition'
  | 'updateStatus'
>;

export type PromptGateActions = {
  launchPromptReview: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    context: ExtensionContext | undefined,
  ) => void;
  queuePromptReviewResult: (
    this: HarnessActionContext,
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => void;
  queuePromptReviewFailure: (
    this: HarnessActionContext,
    active: ActivePromptReview,
    reason: string,
  ) => void;
  finishPromptReview: (
    this: HarnessActionContext,
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => Promise<void>;
  pausePromptGate: (
    this: HarnessActionContext,
    requestId: string,
    reason: string,
    isFailed: boolean,
  ) => void;
  cancelPromptReview: (this: HarnessActionContext) => void;
};

function launchPromptReview(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  context: ExtensionContext | undefined,
): void {
  const pendingGate = run.pendingGate;
  if (!pendingGate || pendingGate.provider !== 'prompt') return;
  if (!context?.hasUI) {
    this.pausePromptGate(
      pendingGate.requestId,
      'Built-in review requires Pi TUI or RPC mode; resume there to continue',
      false,
    );
    return;
  }
  if (this.activePromptReview?.requestId === pendingGate.requestId) return;
  this.cancelPromptReview();

  const active: ActivePromptReview = {
    requestId: pendingGate.requestId,
    runId: run.runId,
    stepId: pendingGate.stepId,
    sessionEpoch: this.sessionEpoch,
    abortController: this.dependencies.createAbortController(),
  };
  this.activePromptReview = active;
  void this.dependencies
    .requestPromptGateReview(
      context.ui,
      `Review ${workflow.definition.id}:${pendingGate.stepId}`,
      pendingGate.artifact,
      active.abortController.signal,
    )
    .then(
      (result) => {
        this.queuePromptReviewResult(active, result);
      },
      (error: unknown) => {
        this.queuePromptReviewFailure(
          active,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
}

function queuePromptReviewResult(
  this: HarnessActionContext,
  active: ActivePromptReview,
  result: PromptGateReviewResult,
): void {
  void this.mutationQueue
    .run(() => this.finishPromptReview(active, result))
    .catch((error: unknown) => {
      this.latestContext?.ui.notify(
        `Cannot apply built-in review: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    });
}

function queuePromptReviewFailure(
  this: HarnessActionContext,
  active: ActivePromptReview,
  reason: string,
): void {
  void this.mutationQueue
    .run(async () => {
      if (this.activePromptReview !== active) return;
      this.activePromptReview = undefined;
      this.pausePromptGate(
        active.requestId,
        `Built-in review failed: ${reason}`,
        true,
      );
    })
    .catch((error: unknown) => {
      this.latestContext?.ui.notify(
        `Cannot pause failed built-in review: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    });
}

async function finishPromptReview(
  this: HarnessActionContext,
  active: ActivePromptReview,
  result: PromptGateReviewResult,
): Promise<void> {
  if (this.activePromptReview !== active) return;
  this.activePromptReview = undefined;
  if (
    !this.isSessionActive ||
    this.sessionEpoch !== active.sessionEpoch ||
    !this.run ||
    this.run.runId !== active.runId ||
    this.run.currentStepId !== active.stepId ||
    this.run.pendingGate?.provider !== 'prompt' ||
    this.run.pendingGate.requestId !== active.requestId
  ) {
    return;
  }
  if (result.status === 'dismissed') {
    this.pausePromptGate(
      active.requestId,
      'Built-in review was dismissed; resume to reopen it',
      false,
    );
    return;
  }

  const resolution: GateResolution = {
    approved: result.approved,
    feedback: result.feedback,
    resolvedAt: this.dependencies.now(),
  };
  if (this.run.status === 'paused') {
    this.run = storeGateResolution(
      this.run,
      resolution,
      this.dependencies.now(),
    );
    this.persist();
    this.latestContext?.ui.notify(
      'Built-in review finished while paused. Run /workflow-resume to apply it.',
      'info',
    );
    return;
  }
  if (this.run.status !== 'awaiting-gate') return;

  const workflow = this.catalog.workflows.get(this.run.workflowId);
  if (!workflow) {
    this.pausePromptGate(
      active.requestId,
      'Built-in review finished, but workflow configuration is unavailable',
      true,
    );
    return;
  }
  try {
    const stepId = this.run.currentStepId;
    const gate = workflow.definition.steps[stepId]?.gate;
    if (!gate) throw new Error(`gated step "${stepId}" no longer exists`);
    this.run = resolveGate(
      workflow,
      this.run,
      resolution,
      this.dependencies.now(),
    );
    this.settleAfterTransition(workflow, {
      stepId,
      outcome: resolution.approved
        ? gate.approvedOutcome
        : gate.rejectedOutcome,
      summary: this.run.lastSummary,
    });
  } catch (error) {
    this.pausePromptGate(
      active.requestId,
      `Cannot apply built-in review: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

function pausePromptGate(
  this: HarnessActionContext,
  requestId: string,
  reason: string,
  isFailed: boolean,
): void {
  if (
    !this.run ||
    this.run.pendingGate?.provider !== 'prompt' ||
    this.run.pendingGate.requestId !== requestId
  ) {
    return;
  }
  const wasAwaitingGate = this.run.status === 'awaiting-gate';
  const didFail = wasAwaitingGate && isFailed;
  const didPause = wasAwaitingGate && !isFailed;
  if (this.run.status === 'awaiting-gate') {
    this.run = isFailed
      ? failRun(this.run, reason, this.dependencies.now())
      : pauseRun(this.run, reason, this.dependencies.now());
  }
  this.persist();
  if (didFail) {
    reportFailedStep(
      this.pi,
      this.catalog.workflows.get(this.run.workflowId),
      this.run,
      reason,
    );
  } else if (didPause) {
    reportPausedStep(
      this.pi,
      this.catalog.workflows.get(this.run.workflowId),
      this.run,
      reason,
    );
  }
  this.restoreBaselineTools();
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Workflow paused at "${this.run.currentStepId}": ${
      isFailed
        ? conciseStepFailureSummary(reason)
        : conciseStepPauseSummary(reason)
    }`,
    'warning',
  );
}

function cancelPromptReview(this: HarnessActionContext): void {
  const active = this.activePromptReview;
  if (!active) return;
  this.activePromptReview = undefined;
  active.abortController.abort();
}

/**
 * Returns built-in prompt-gate actions for harness composition.
 */
export function createPromptGateActions(): PromptGateActions {
  return {
    launchPromptReview,
    queuePromptReviewResult,
    queuePromptReviewFailure,
    finishPromptReview,
    pausePromptGate,
    cancelPromptReview,
  };
}
