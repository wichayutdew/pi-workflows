import type { LoadedWorkflow } from '../config/types.ts';
import {
  rebuildVisits,
  refreshApprovedGateHistory,
  retainedReviewedApproval,
  retainedWorkspaceCwd,
} from './reconciliation-history.ts';
import type { WorkflowRun } from './state-types.ts';
import { withRunUpdate } from './transition-helpers.ts';
import type { ReconcileResult } from './transition-types.ts';
import { validateRunWorkflowSemantics } from './run-workflow-validation.ts';

/**
 * Reconciles persisted run state with a reloaded workflow configuration.
 *
 * The earliest changed completed step is restarted. Changes limited to the
 * current step restart that step, while incompatible removals return an error.
 *
 * @param run - Persisted workflow state.
 * @param workflow - Reloaded workflow.
 * @param now - Reconciliation timestamp.
 * @returns Reconciled state and restart metadata.
 */
export const reconcileRun = (
  run: WorkflowRun,
  workflow: LoadedWorkflow,
  now: number,
): ReconcileResult => {
  if (run.workflowId !== workflow.definition.id) {
    return {
      changed: false,
      error: `run belongs to "${run.workflowId}", not "${workflow.definition.id}"`,
    };
  }
  const reconciledRun =
    run.workflowDigest === workflow.digest
      ? run
      : refreshApprovedGateHistory(run, workflow);
  const changedHistoryIndex =
    run.workflowDigest === workflow.digest
      ? -1
      : reconciledRun.history.findIndex(
          (entry) => workflow.stepDigests[entry.stepId] !== entry.stepDigest,
        );
  const changedHistoryEntry =
    changedHistoryIndex >= 0
      ? reconciledRun.history[changedHistoryIndex]
      : undefined;
  if (
    changedHistoryEntry &&
    !workflow.definition.steps[changedHistoryEntry.stepId]
  ) {
    return {
      changed: true,
      error: 'a completed step was removed; abort or restore the configuration',
    };
  }
  if (
    changedHistoryIndex < 0 &&
    !workflow.definition.steps[run.currentStepId]
  ) {
    return {
      changed: true,
      error: `current step "${run.currentStepId}" was removed; abort or restore the configuration`,
    };
  }
  const semanticError = validateRunWorkflowSemantics(reconciledRun, workflow);
  if (semanticError) {
    return {
      changed: run.workflowDigest !== workflow.digest,
      error: `workflow checkpoint is inconsistent: ${semanticError}`,
    };
  }
  if (run.workflowDigest === workflow.digest) {
    return { run, changed: false };
  }
  if (changedHistoryIndex >= 0) {
    const changedEntry = changedHistoryEntry;
    if (!changedEntry) {
      return { changed: true, error: 'changed history entry is unavailable' };
    }

    const retainedHistory = reconciledRun.history.slice(0, changedHistoryIndex);
    const restartedStep = changedEntry.stepId;
    const stepHandoff = retainedHistory.at(-1)?.summary ?? '';
    const reviewedApproval = retainedReviewedApproval(
      workflow,
      retainedHistory,
    );
    return {
      changed: true,
      restartedStep,
      run: withRunUpdate(
        reconciledRun,
        {
          workflowDigest: workflow.digest,
          status: 'paused',
          currentStepId: restartedStep,
          currentStepDigest: workflow.stepDigests[restartedStep] ?? '',
          history: retainedHistory,
          currentStepAttempts: changedEntry.attempts,
          currentStepOmittedAttempts: changedEntry.omittedAttempts,
          currentStepUsage: changedEntry.usage,
          visits: rebuildVisits(retainedHistory, restartedStep),
          cwd: retainedWorkspaceCwd(reconciledRun, retainedHistory),
          reviewedArtifact: reviewedApproval?.artifact ?? '',
          reviewedFeedback: reviewedApproval?.feedback ?? '',
          stepHandoff,
          lastSummary: stepHandoff,
          pendingGate: undefined,
          pausedFrom: 'running',
          failedStepId: undefined,
          pauseReason: `Configuration changed; restarted step "${restartedStep}"`,
          gateArtifact: '',
          gateFeedback: '',
        },
        now,
      ),
    };
  }

  const currentDigest = workflow.stepDigests[run.currentStepId] ?? '';
  const hasCurrentStepChanged =
    currentDigest !== reconciledRun.currentStepDigest;
  const restartChanges: Partial<WorkflowRun> = hasCurrentStepChanged
    ? {
        status: 'paused',
        pendingGate: undefined,
        pausedFrom: 'running',
        failedStepId: undefined,
        pauseReason: `Configuration changed; restarted step "${run.currentStepId}"`,
        gateArtifact: '',
        gateFeedback: '',
      }
    : {};
  return {
    changed: true,
    ...(hasCurrentStepChanged ? { restartedStep: run.currentStepId } : {}),
    run: withRunUpdate(
      reconciledRun,
      {
        ...restartChanges,
        workflowDigest: workflow.digest,
        currentStepDigest: currentDigest,
      },
      now,
    ),
  };
};
