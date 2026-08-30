import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

export type RunStepEffects = {
  /** Canonical directory selected through the step's YAML-authorized result. */
  readonly workspaceCwd?: string | undefined;
};

export type RunAdvanceOptions = {
  /**
   * Marks an explicit human rejection back to the same gated step. This keeps
   * the incoming handoff and bypasses the visit-limit check for this decision.
   */
  readonly sameStepHumanGateRevision?: boolean | undefined;
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
  ...(run.currentStepUsage ? { usage: run.currentStepUsage } : {}),
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
 * @param options - Internal graph-advancement controls.
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
  options: RunAdvanceOptions = {},
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
  if (
    shouldBindWorkspace &&
    run.restartWorkspaceCwd !== undefined &&
    effects.workspaceCwd !== run.restartWorkspaceCwd
  ) {
    throw new Error(
      `restarted workflow must rebind workspace "${run.restartWorkspaceCwd}"`,
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
    if (run.restartWorkspaceCwd !== undefined) {
      throw new Error(
        `restarted workflow completed before rebinding workspace "${run.restartWorkspaceCwd}"`,
      );
    }
    return withRunUpdate(
      run,
      {
        status: 'completed',
        history: [...run.history, completed],
        currentStepAttempts: undefined,
        currentStepOmittedAttempts: undefined,
        currentStepUsage: undefined,
        ...(cwd ? { cwd } : {}),
        ...(effects.workspaceCwd ? { restartWorkspaceCwd: undefined } : {}),
        stepHandoff: summary,
        lastSummary: summary,
        gateArtifact: '',
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

  const preservesGateRevisionContext =
    target === run.currentStepId &&
    (options.sameStepHumanGateRevision || Boolean(run.gateArtifact));
  const preservesHandoffContext =
    target === run.currentStepId &&
    outcome === 'handoff' &&
    Boolean(run.stepHandoff);
  const nextStepHandoff = preservesGateRevisionContext
    ? run.stepHandoff
    : preservesHandoffContext
      ? `${run.stepHandoff}\n\nLatest handoff:\n${summary}`
      : summary;
  const nextVisitCount = (run.visits[target] ?? 0) + 1;
  const isOverVisitLimit =
    !options.sameStepHumanGateRevision &&
    nextVisitCount > workflow.definition.maxStepVisits;
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
      currentStepUsage: undefined,
      ...(cwd ? { cwd } : {}),
      ...(effects.workspaceCwd ? { restartWorkspaceCwd: undefined } : {}),
      stepHandoff: nextStepHandoff,
      lastSummary: summary,
      gateArtifact: preservesGateRevisionContext ? run.gateArtifact : '',
      gateFeedback: preservesGateRevisionContext ? run.gateFeedback : '',
      resumeInput: undefined,
    },
    now,
  );
};
