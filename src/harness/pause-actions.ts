import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { abortRun, pauseRun } from '../engine/transitions.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'cancelActiveDelegation'
  | 'cancelPromptReview'
  | 'dependencies'
  | 'isolateMainSessionTools'
  | 'mainSteps'
  | 'persist'
  | 'restoreBaselineTools'
  | 'run'
  | 'updateStatus'
>;

export type PauseActions = {
  pauseNow: (
    this: HarnessActionContext,
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  abortNow: (
    this: HarnessActionContext,
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
};

async function pauseNow(
  this: HarnessActionContext,
  reason: string,
  context: ExtensionCommandContext,
): Promise<void> {
  if (
    !this.run ||
    this.run.status === 'completed' ||
    this.run.status === 'aborted'
  ) {
    context.ui.notify('No active workflow to pause', 'warning');
    return;
  }
  if (this.run.status === 'paused') {
    context.ui.notify(
      `Workflow is already paused${this.run.pauseReason ? `: ${this.run.pauseReason}` : ''}`,
      'info',
    );
    return;
  }
  this.cancelPromptReview();
  const isMainStepSuspended = this.mainSteps.suspend();
  const isCancellationConfirmed = await this.cancelActiveDelegation(
    'Workflow paused by user',
  );
  if (!context.isIdle()) {
    context.abort();
    if (isMainStepSuspended) await context.waitForIdle();
  }

  this.run = pauseRun(this.run, reason, this.dependencies.now());
  this.persist();
  if (isCancellationConfirmed) {
    this.restoreBaselineTools();
  } else {
    this.isolateMainSessionTools();
  }
  this.updateStatus();
  context.ui.notify(
    isCancellationConfirmed
      ? `Paused "${this.run.workflowId}" at step "${this.run.currentStepId}". Fix the issue, then run /workflow-resume.`
      : `Pause recorded at "${this.run.currentStepId}", but child cancellation is not confirmed. Main tools remain isolated until it exits.`,
    isCancellationConfirmed ? 'info' : 'warning',
  );
}

async function abortNow(
  this: HarnessActionContext,
  reason: string,
  context: ExtensionCommandContext,
): Promise<void> {
  if (
    !this.run ||
    this.run.status === 'completed' ||
    this.run.status === 'aborted'
  ) {
    context.ui.notify('No active workflow to abort', 'warning');
    return;
  }
  this.cancelPromptReview();
  const isMainStepSuspended = this.mainSteps.suspend();
  const isCancellationConfirmed = await this.cancelActiveDelegation(
    'Workflow aborted by user',
  );
  if (!context.isIdle()) {
    context.abort();
    if (isMainStepSuspended) await context.waitForIdle();
  }
  this.run = abortRun(this.run, reason, this.dependencies.now());
  this.persist();
  if (isCancellationConfirmed) {
    this.restoreBaselineTools();
  } else {
    this.isolateMainSessionTools();
  }
  this.updateStatus();
  context.ui.notify(
    isCancellationConfirmed
      ? `Aborted workflow "${this.run.workflowId}"`
      : `Workflow "${this.run.workflowId}" is aborted, but its child has not confirmed cancellation; main tools remain isolated`,
    isCancellationConfirmed ? 'info' : 'warning',
  );
}

/**
 * Returns pause and abort actions for harness composition.
 */
export function createPauseActions(): PauseActions {
  return { pauseNow, abortNow };
}
