import { failRun } from '../engine/transitions.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import {
  boundedFailureField,
  MAX_DELEGATION_RECOVERY_ATTEMPTS,
} from './delegation-retry-policy.ts';
import type { ActiveDelegation, DelegationFailureDetails } from './types.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'catalog'
  | 'cleanupDelegation'
  | 'delegationFailures'
  | 'dependencies'
  | 'isSessionActive'
  | 'isolateMainSessionTools'
  | 'latestContext'
  | 'launchCurrentStep'
  | 'mainSteps'
  | 'pauseForExecutionFailure'
  | 'persist'
  | 'restoreBaselineTools'
  | 'run'
  | 'sessionEpoch'
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
  retryDelegationAfterFailure: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    failure: DelegationFailureDetails | undefined,
    reason: string,
  ) => boolean;
  pauseForDelegationFailure: (
    this: HarnessActionContext,
    reason: string,
  ) => void;
  pauseForExecutionFailure: (
    this: HarnessActionContext,
    label: string,
    reason: string,
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

function retryDelegationAfterFailure(
  this: HarnessActionContext,
  active: ActiveDelegation,
  failure: DelegationFailureDetails | undefined,
  reason: string,
): boolean {
  if (!failure) return false;
  const fingerprint =
    this.delegationFailures.delegationFailureFingerprint(failure);
  const isRepeatedFailure = active.recoveryFailures.some(
    (previousFailure) => previousFailure.fingerprint === fingerprint,
  );
  if (
    active.recoveryAttemptCount >= MAX_DELEGATION_RECOVERY_ATTEMPTS ||
    isRepeatedFailure ||
    !this.delegationFailures.isRetryableTerminalFailure(failure) ||
    !this.delegationFailures.isSafeToRetryDelegation(
      active.policy,
      active.broadRecoveryAuthorized,
      failure.replayAudit,
    ) ||
    !this.isSessionActive ||
    this.sessionEpoch !== active.sessionEpoch ||
    !this.run ||
    this.run.status !== 'running' ||
    this.run.runId !== active.runId ||
    this.run.currentStepId !== active.stepId ||
    this.run.currentStepDigest !== active.stepDigest ||
    this.activeDelegation
  ) {
    return false;
  }
  const workflow = this.catalog.workflows.get(this.run.workflowId);
  if (!workflow) return false;

  const attempt = active.recoveryAttemptCount + 1;
  this.latestContext?.ui.notify(
    `Automatic recovery for "${active.stepId}" after a subagent failure (${attempt}/${MAX_DELEGATION_RECOVERY_ATTEMPTS})`,
    'warning',
  );
  this.launchCurrentStep(workflow, {
    attempt,
    failures: [...active.recoveryFailures, { fingerprint, reason }],
  });
  return true;
}

function pauseForDelegationFailure(
  this: HarnessActionContext,
  reason: string,
): void {
  this.pauseForExecutionFailure('Subagent step', reason);
}

function pauseForExecutionFailure(
  this: HarnessActionContext,
  label: string,
  reason: string,
): void {
  if (!this.run || this.run.status !== 'running') return;
  this.mainSteps.deactivate();
  this.run = failRun(
    this.run,
    `${label} failed: ${reason}`,
    this.dependencies.now(),
  );
  this.persist();
  if (this.activeDelegation) {
    this.isolateMainSessionTools();
  } else {
    this.restoreBaselineTools();
  }
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Workflow paused at "${this.run.currentStepId}": ${reason}`,
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
  if (this.run?.status === 'running') {
    this.run = failRun(
      this.run,
      `Subagent step failed: ${reason}`,
      this.dependencies.now(),
    );
    this.persist();
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
    retryDelegationAfterFailure,
    pauseForDelegationFailure,
    pauseForExecutionFailure,
    retainUnconfirmedDelegation,
    releaseMainAfterCancellation,
  };
}
