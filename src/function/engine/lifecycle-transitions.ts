import type { LoadedWorkflow, WorkflowRun } from '../../domain/index.ts';
import { createRun } from './create-run.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

const completedWorkspaceCwd = (run: WorkflowRun): string | undefined => {
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    const workspaceCwd = run.history[index]?.workspaceCwd;
    if (workspaceCwd) return workspaceCwd;
  }
  return undefined;
};

/**
 * Lists outcomes the active step may submit directly.
 *
 * Gate resolution outcomes are reserved for the gate; only its submit outcome
 * is exposed to step execution.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current workflow state.
 * @returns Allowed outcome names.
 */
export const allowedOutcomes = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): Array<string> => {
  const step = currentStep(workflow, run);
  if (!step) return [];

  const gateResolutionOutcomes = step.gate
    ? new Set([step.gate.approvedOutcome, step.gate.rejectedOutcome])
    : undefined;
  return [
    ...Object.keys(step.transitions).filter(
      (outcome) => !gateResolutionOutcomes?.has(outcome),
    ),
    ...(step.gate ? [step.gate.submitOutcome] : []),
  ];
};

/**
 * Pauses an active run while preserving its previous execution mode.
 *
 * @param run - Current workflow state.
 * @param reason - User-facing pause reason.
 * @param now - Update timestamp.
 * @returns A new paused workflow state.
 */
export const pauseRun = (
  run: WorkflowRun,
  reason: string,
  now: number,
): WorkflowRun => {
  if (run.status !== 'running' && run.status !== 'awaiting-gate') {
    return withRunUpdate(run, { pauseReason: reason || run.pauseReason }, now);
  }
  return withRunUpdate(
    run,
    {
      status: 'paused',
      pausedFrom: run.status,
      pauseReason: reason || `Paused during step "${run.currentStepId}"`,
      failedStepId: undefined,
    },
    now,
  );
};

/**
 * Pauses a run and marks its current step as failed for a resumable retry.
 *
 * @param run - Current workflow state.
 * @param reason - Failure reason.
 * @param now - Update timestamp.
 * @returns A new failed-and-paused workflow state.
 */
export const failRun = (
  run: WorkflowRun,
  reason: string,
  now: number,
): WorkflowRun => {
  const pausedRun = pauseRun(run, reason, now);
  return pausedRun.status === 'paused'
    ? { ...pausedRun, failedStepId: pausedRun.currentStepId }
    : pausedRun;
};

/**
 * Resumes a paused run in the mode from which it was paused.
 *
 * @param run - Current workflow state.
 * @param now - Update timestamp.
 * @returns A resumed state, or the unchanged state when it was not paused.
 */
export const resumeRun = (run: WorkflowRun, now: number): WorkflowRun => {
  if (run.status !== 'paused') return run;
  return withRunUpdate(
    run,
    {
      status: run.pausedFrom ?? (run.pendingGate ? 'awaiting-gate' : 'running'),
      pauseReason: undefined,
      pausedFrom: undefined,
      failedStepId: undefined,
    },
    now,
  );
};

/**
 * Replaces the user-authored guidance for one explicit resume attempt.
 */
export const setResumeInput = (
  run: WorkflowRun,
  input: string,
  now: number,
): WorkflowRun =>
  withRunUpdate(run, { resumeInput: input.trim() || undefined }, now);

/**
 * Aborts a run and clears resumable gate state.
 *
 * @param run - Current workflow state.
 * @param reason - User-facing abort reason.
 * @param now - Update timestamp.
 * @returns A new aborted workflow state.
 */
export const abortRun = (
  run: WorkflowRun,
  reason: string,
  now: number,
): WorkflowRun =>
  withRunUpdate(
    run,
    {
      status: 'aborted',
      pauseReason: reason || 'Aborted by user',
      pausedFrom: undefined,
      failedStepId: undefined,
      pendingGate: undefined,
      resumeInput: undefined,
    },
    now,
  );

/**
 * Starts another iteration of a completed workflow while retaining its stable
 * run/worktree lineage. The next workspace-binding result must reaffirm the
 * previously selected workspace before the iteration can complete.
 *
 * @param workflow - Current loaded workflow definition.
 * @param run - Completed iteration to restart.
 * @param input - New request, or the prior request when no replacement was supplied.
 * @param baselineTools - Tools available before the new iteration is isolated.
 * @param now - Restart timestamp.
 * @returns A fresh running state for the next iteration.
 */
export const restartRun = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  input: string,
  baselineTools: ReadonlyArray<string>,
  now: number,
): WorkflowRun => {
  if (run.status !== 'completed') {
    throw new Error('only a completed workflow can be restarted');
  }
  if (!run.startCwd) {
    throw new Error(
      'the completed workflow has no captured start directory; start a new workflow instead',
    );
  }

  const previousIteration = run.iteration ?? 1;
  if (!Number.isSafeInteger(previousIteration) || previousIteration < 1) {
    throw new Error('the completed workflow has an invalid iteration number');
  }
  if (previousIteration >= Number.MAX_SAFE_INTEGER) {
    throw new Error('the workflow iteration limit has been reached');
  }

  const workspaceCwd = completedWorkspaceCwd(run);
  if (workspaceCwd && run.cwd !== workspaceCwd) {
    throw new Error(
      'the completed workflow workspace does not match its recorded binding',
    );
  }

  const restarted = createRun(
    workflow,
    input,
    baselineTools,
    run.runId,
    now,
    run.startCwd,
    previousIteration + 1,
  );
  return {
    ...restarted,
    stepHandoff: run.lastSummary,
    lastSummary: run.lastSummary,
    ...(workspaceCwd ? { restartWorkspaceCwd: workspaceCwd } : {}),
  };
};
