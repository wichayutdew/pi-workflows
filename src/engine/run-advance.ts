import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

const completedStep = (
  run: WorkflowRun,
  outcome: string,
  summary: string,
  now: number,
): StepHistoryEntry => ({
  stepId: run.currentStepId,
  stepDigest: run.currentStepDigest,
  outcome,
  summary,
  completedAt: now,
});

/**
 * Advances a running workflow through a configured non-gate transition.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current running workflow state.
 * @param outcome - Submitted step outcome.
 * @param summary - Step handoff summary.
 * @param now - Update timestamp.
 * @returns A new paused, running, or completed workflow state.
 * @throws When the run, outcome, current step, or transition target is invalid.
 */
export const advanceRun = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  outcome: string,
  summary: string,
  now: number,
): WorkflowRun => {
  if (run.status !== 'running') {
    throw new Error(
      `workflow is ${run.status}; only a running workflow can advance`,
    );
  }

  const step = currentStep(workflow, run);
  if (!step) {
    throw new Error(`current step "${run.currentStepId}" no longer exists`);
  }
  if (step.gate?.submitOutcome === outcome) {
    throw new Error(
      `outcome "${outcome}" must be submitted through the configured gate`,
    );
  }

  const target = step.transitions[outcome];
  if (!target) {
    throw new Error(
      `outcome "${outcome}" is not valid for step "${run.currentStepId}"`,
    );
  }
  if (target === '$pause') {
    return withRunUpdate(
      run,
      {
        status: 'paused',
        pausedFrom: 'running',
        pauseReason: summary || `Step "${run.currentStepId}" requested a pause`,
        lastSummary: summary,
      },
      now,
    );
  }

  const completed = completedStep(run, outcome, summary, now);
  if (target === '$done') {
    return withRunUpdate(
      run,
      {
        status: 'completed',
        history: [...run.history, completed],
        stepHandoff: summary,
        lastSummary: summary,
        gateFeedback: '',
        pausedFrom: undefined,
        pendingGate: undefined,
      },
      now,
    );
  }

  const nextStep = workflow.definition.steps[target];
  if (!nextStep) {
    throw new Error(`transition target "${target}" does not exist`);
  }

  const nextVisitCount = (run.visits[target] ?? 0) + 1;
  const isOverVisitLimit = nextVisitCount > workflow.definition.maxStepVisits;
  const visitLimitChanges: Partial<WorkflowRun> = isOverVisitLimit
    ? {
        status: 'paused',
        pausedFrom: 'running',
        pauseReason: `Step "${target}" exceeded maxStepVisits (${workflow.definition.maxStepVisits})`,
      }
    : {
        status: 'running',
        pausedFrom: undefined,
        pauseReason: undefined,
      };

  return withRunUpdate(
    run,
    {
      ...visitLimitChanges,
      currentStepId: target,
      currentStepDigest: workflow.stepDigests[target] ?? '',
      visits: { ...run.visits, [target]: nextVisitCount },
      history: [...run.history, completed],
      stepHandoff: summary,
      lastSummary: summary,
      gateFeedback: '',
      ...(nextStep.gate ? { reviewedArtifact: '', reviewedFeedback: '' } : {}),
    },
    now,
  );
};
