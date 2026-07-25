import type { LoadedWorkflow } from '../config/types.ts';
import {
  rebuildVisits,
  refreshApprovedGateHistory,
  retainedReviewedArtifact,
} from './reconciliation-history.ts';
import type { WorkflowRun } from './state-types.ts';
import { withRunUpdate } from './transition-helpers.ts';
import type { ReconcileResult } from './transition-types.ts';

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
  if (run.workflowDigest === workflow.digest) {
    return { run, changed: false };
  }
  if (!workflow.definition.steps[run.currentStepId]) {
    return {
      changed: true,
      error: `current step "${run.currentStepId}" was removed; abort or restore the configuration`,
    };
  }

  const reconciledRun = refreshApprovedGateHistory(run, workflow);
  const changedHistoryIndex = reconciledRun.history.findIndex(
    (entry) => workflow.stepDigests[entry.stepId] !== entry.stepDigest,
  );
  if (changedHistoryIndex >= 0) {
    const changedEntry = reconciledRun.history[changedHistoryIndex];
    if (!changedEntry || !workflow.definition.steps[changedEntry.stepId]) {
      return {
        changed: true,
        error:
          'a completed step was removed; abort or restore the configuration',
      };
    }

    const retainedHistory = reconciledRun.history.slice(0, changedHistoryIndex);
    const restartedStep = changedEntry.stepId;
    const stepHandoff = retainedHistory.at(-1)?.summary ?? '';
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
          visits: rebuildVisits(retainedHistory, restartedStep),
          reviewedArtifact: retainedReviewedArtifact(
            workflow,
            reconciledRun,
            retainedHistory,
          ),
          stepHandoff,
          lastSummary: stepHandoff,
          pendingGate: undefined,
          pausedFrom: 'running',
          failedStepId: undefined,
          pauseReason: `Configuration changed; restarted step "${restartedStep}"`,
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
