import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun } from './state-types.ts';
import { currentStep, withRunUpdate } from './transition-helpers.ts';

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
    },
    now,
  );
