import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from './state-types.ts';

/**
 * Finds the workflow definition for a run's current step.
 *
 * @param workflow - Loaded workflow.
 * @param run - Current workflow state.
 * @returns The current step, or `undefined` if configuration drift removed it.
 */
export const currentStep = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): WorkflowStep | undefined => workflow.definition.steps[run.currentStepId];

/**
 * Produces a workflow state with changes and a refreshed update timestamp.
 *
 * @param run - Existing workflow state.
 * @param changes - Fields to replace.
 * @param now - Update timestamp.
 * @returns A new workflow state.
 */
export const withRunUpdate = (
  run: WorkflowRun,
  changes: Partial<WorkflowRun>,
  now: number,
): WorkflowRun => ({ ...run, ...changes, updatedAt: now });
