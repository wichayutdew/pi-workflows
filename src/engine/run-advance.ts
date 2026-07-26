import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

export type RunStepEffects = {
  /** Canonical directory selected through the step's YAML-authorized result. */
  readonly workspaceCwd?: string | undefined;
};

const completedStep = (
  run: WorkflowRun,
  outcome: string,
  summary: string,
  now: number,
  effects: RunStepEffects,
): StepHistoryEntry => ({
  stepId: run.currentStepId,
  stepDigest: run.currentStepDigest,
  outcome,
  summary,
  ...(effects.workspaceCwd ? { workspaceCwd: effects.workspaceCwd } : {}),
  ...(run.currentStepAttempts?.length
    ? { attempts: run.currentStepAttempts }
    : {}),
  ...(run.currentStepOmittedAttempts
    ? { omittedAttempts: run.currentStepOmittedAttempts }
    : {}),
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
 * @param effects - Validated declarative effects accepted with this result.
 * @returns A new paused, running, or completed workflow state.
 * @throws When the run, outcome, current step, or transition target is invalid.
 */
export const advanceRun = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  outcome: string,
  summary: string,
  now: number,
  effects: RunStepEffects = {},
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
  const shouldBindWorkspace = step.workspace?.bindOn.includes(outcome) ?? false;
  if (shouldBindWorkspace !== Boolean(effects.workspaceCwd)) {
    throw new Error(
      shouldBindWorkspace
        ? `outcome "${outcome}" requires a validated workspace binding`
        : `outcome "${outcome}" cannot bind a workspace`,
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
        resumeInput: undefined,
      },
      now,
    );
  }

  const completed = completedStep(run, outcome, summary, now, effects);
  const cwd = effects.workspaceCwd ?? run.cwd;
  if (target === '$done') {
    return withRunUpdate(
      run,
      {
        status: 'completed',
        history: [...run.history, completed],
        currentStepAttempts: undefined,
        currentStepOmittedAttempts: undefined,
        ...(cwd ? { cwd } : {}),
        stepHandoff: summary,
        lastSummary: summary,
        gateFeedback: '',
        pausedFrom: undefined,
        pendingGate: undefined,
        resumeInput: undefined,
      },
      now,
    );
  }

  if (!workflow.definition.steps[target]) {
    throw new Error(`transition target "${target}" does not exist`);
  }

  const nextVisitCount = (run.visits[target] ?? 0) + 1;
  const isOverVisitLimit = nextVisitCount > workflow.definition.maxStepVisits;
  const visitLimitChanges: Partial<WorkflowRun> = isOverVisitLimit
    ? {
        status: 'paused',
        pausedFrom: 'running',
        pauseReason: `Step "${target}" exceeded maxStepVisits (${workflow.definition.maxStepVisits})`,
        failedStepId: target,
      }
    : {
        status: 'running',
        pausedFrom: undefined,
        pauseReason: undefined,
        failedStepId: undefined,
      };

  return withRunUpdate(
    run,
    {
      ...visitLimitChanges,
      currentStepId: target,
      currentStepDigest: workflow.stepDigests[target] ?? '',
      visits: { ...run.visits, [target]: nextVisitCount },
      history: [...run.history, completed],
      currentStepAttempts: undefined,
      currentStepOmittedAttempts: undefined,
      ...(cwd ? { cwd } : {}),
      stepHandoff: summary,
      lastSummary: summary,
      gateFeedback: '',
      resumeInput: undefined,
    },
    now,
  );
};
