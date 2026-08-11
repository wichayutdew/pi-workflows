import { failRun } from '../engine/transitions.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import {
  conciseStepFailureSummary,
  reportFailedStep,
} from './step-reporting.ts';
import type { ActiveDelegation } from './types.ts';

const boundedFailureField = (value: string): string =>
  value.length <= 500 ? value : `${value.slice(0, 499)}…`;

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'catalog'
  | 'cleanupDelegation'
  | 'dependencies'
  | 'isolateMainSessionTools'
  | 'latestContext'
  | 'mainSteps'
  | 'pauseForExecutionFailure'
  | 'persist'
  | 'pi'
  | 'restoreBaselineTools'
  | 'run'
  | 'subagents'
  | 'updateStatus'
>;

export type DelegationControlActions = {
  cancelActiveDelegation: (
    this: HarnessActionContext,
    reason: string,
  ) => Promise<boolean>;
  cleanupDelegation: (
    this: HarnessActionContext,
    active: ActiveDelegation,
  ) => Promise<void>;
  pauseForDelegationFailure: (
    this: HarnessActionContext,
    reason: string,
    failureSummary?: string,
  ) => void;
  pauseForExecutionFailure: (
    this: HarnessActionContext,
    label: string,
    reason: string,
    failureSummary?: string,
  ) => void;
  retainUnconfirmedDelegation: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    reason: string,
  ) => void;
  releaseMainAfterCancellation: (
    this: HarnessActionContext,
    active: ActiveDelegation,
  ) => void;
};

async function cancelActiveDelegation(
  this: HarnessActionContext,
  reason: string,
): Promise<boolean> {
  const active = this.activeDelegation;
  if (!active) return true;
  active.cancelling = true;
  active.progress = 'cancelling';
  this.updateStatus();
  if (this.subagents.activeRequestId !== active.requestId) {
    active.progress = 'cancellation unconfirmed';
    this.updateStatus();
    this.latestContext?.ui.notify(
      `${reason}; the delegation channel already closed without a terminal response`,
      'warning',
    );
    return false;
  }
  const isConfirmed = await this.subagents.cancelActiveAndWait();
  if (isConfirmed && this.activeDelegation === active) {
    this.activeDelegation = undefined;
    await this.cleanupDelegation(active);
  } else if (!isConfirmed) {
    this.latestContext?.ui.notify(
      `${reason}; waiting for subagent "${active.agent}" to confirm termination`,
      'warning',
    );
  }
  return isConfirmed;
}

async function cleanupDelegation(
  this: HarnessActionContext,
  active: ActiveDelegation,
): Promise<void> {
  try {
    await this.dependencies.removeDelegationWorkspace(active.resultDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      this.latestContext?.ui.notify(
        `Could not remove temporary delegation workspace "${active.resultDirectory}": ${boundedFailureField(detail)}`,
        'warning',
      );
    } catch {
      // Cleanup and its warning are housekeeping; neither may pause the run.
    }
  }
}

function pauseForDelegationFailure(
  this: HarnessActionContext,
  reason: string,
  failureSummary = reason,
): void {
  this.pauseForExecutionFailure('Subagent step', reason, failureSummary);
}

function pauseForExecutionFailure(
  this: HarnessActionContext,
  label: string,
  reason: string,
  failureSummary = reason,
): void {
  if (!this.run || this.run.status !== 'running') return;
  this.mainSteps.deactivate();
  this.run = failRun(
    this.run,
    `${label} failed: ${reason}`,
    this.dependencies.now(),
  );
  this.persist();
  reportFailedStep(
    this.pi,
    this.catalog.workflows.get(this.run.workflowId),
    this.run,
    failureSummary,
  );
  if (this.activeDelegation) {
    this.isolateMainSessionTools();
  } else {
    this.restoreBaselineTools();
  }
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Workflow paused at "${this.run.currentStepId}": ${conciseStepFailureSummary(failureSummary)}`,
    'error',
  );
}

function retainUnconfirmedDelegation(
  this: HarnessActionContext,
  active: ActiveDelegation,
  reason: string,
): void {
  active.cancelling = true;
  active.progress = 'cancellation unconfirmed';
  let didFail = false;
  if (this.run?.status === 'running') {
    this.run = failRun(
      this.run,
      `Subagent step failed: ${reason}`,
      this.dependencies.now(),
    );
    this.persist();
    didFail = true;
  }
  if (didFail && this.run) {
    reportFailedStep(
      this.pi,
      this.catalog.workflows.get(this.run.workflowId),
      this.run,
      reason,
    );
  }
  this.isolateMainSessionTools();
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Workflow paused, but subagent "${active.agent}" has not confirmed termination. Main tools and resume remain blocked; restart Pi if no terminal response arrives.`,
    'error',
  );
}

function releaseMainAfterCancellation(
  this: HarnessActionContext,
  active: ActiveDelegation,
): void {
  if (this.activeDelegation === active) this.activeDelegation = undefined;
  if (
    !this.activeDelegation &&
    this.run &&
    this.run.status !== 'running' &&
    this.run.status !== 'awaiting-gate'
  ) {
    this.restoreBaselineTools();
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Subagent "${active.agent}" has terminated; main tools are restored`,
      'info',
    );
  }
}

/**
 * Returns delegation cancellation and recovery actions for composition.
 */
export function createDelegationControlActions(): DelegationControlActions {
  return {
    cancelActiveDelegation,
    cleanupDelegation,
    pauseForDelegationFailure,
    pauseForExecutionFailure,
    retainUnconfirmedDelegation,
    releaseMainAfterCancellation,
  };
}
