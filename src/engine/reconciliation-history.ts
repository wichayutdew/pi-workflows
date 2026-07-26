import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';

type ReviewedApproval = {
  readonly artifact: string;
  readonly feedback: string;
};

const isApprovedGateEntry = (
  workflow: LoadedWorkflow,
  entry: StepHistoryEntry,
): boolean => {
  const gate = workflow.definition.steps[entry.stepId]?.gate;
  return gate !== undefined && entry.outcome === gate.approvedOutcome;
};

const latestApprovedGateEntry = (
  workflow: LoadedWorkflow,
  history: ReadonlyArray<StepHistoryEntry>,
): { readonly entry: StepHistoryEntry; readonly index: number } | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry && isApprovedGateEntry(workflow, entry)) return { entry, index };
  }
  return undefined;
};

/**
 * Rebuilds step visit counts from retained history and the current step.
 *
 * @param history - Retained completed-step history.
 * @param currentStepId - Step about to run.
 * @returns Visit counts for the reconciled state.
 */
export const rebuildVisits = (
  history: ReadonlyArray<StepHistoryEntry>,
  currentStepId: string,
): Readonly<Record<string, number>> => {
  const visitedStepIds = [
    ...history.map((entry) => entry.stepId),
    currentStepId,
  ];
  return visitedStepIds.reduce<Record<string, number>>(
    (visits, stepId) => ({
      ...visits,
      [stepId]: (visits[stepId] ?? 0) + 1,
    }),
    {},
  );
};

/**
 * Restores the execution directory represented by retained history.
 *
 * @param run - Existing workflow state with immutable start directory.
 * @param history - History retained after reconciliation.
 * @returns The latest retained binding, or the workflow start directory.
 */
export const retainedWorkspaceCwd = (
  run: WorkflowRun,
  history: ReadonlyArray<StepHistoryEntry>,
): string | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const cwd = history[index]?.workspaceCwd;
    if (cwd) return cwd;
  }
  return run.startCwd ?? run.cwd;
};

/**
 * Restores one reviewed approval from the latest retained approving history.
 *
 * Approved history records carry their own artifact, feedback, gate request
 * identity, and prompt-excluded structural digest.
 *
 * @param workflow - Updated workflow.
 * @param history - History retained after reconciliation.
 * @returns The retained pair, or `undefined` when provenance was lost.
 */
export const retainedReviewedApproval = (
  workflow: LoadedWorkflow,
  history: ReadonlyArray<StepHistoryEntry>,
): ReviewedApproval | undefined => {
  const retainedApproval = latestApprovedGateEntry(workflow, history);
  const approval = retainedApproval?.entry.approval;
  return approval
    ? { artifact: approval.artifact, feedback: approval.feedback }
    : undefined;
};

/**
 * Refreshes the digest of retained approved-gate history.
 *
 * The approved history's prompt-excluded structural digest must still match,
 * allowing only a prompt-only refresh without discarding the reviewed value.
 *
 * @param run - Existing workflow state.
 * @param workflow - Updated workflow.
 * @returns A run with refreshed history when needed.
 */
export const refreshApprovedGateHistory = (
  run: WorkflowRun,
  workflow: LoadedWorkflow,
): WorkflowRun => {
  const history = run.history.map((entry) => {
    const gate = workflow.definition.steps[entry.stepId]?.gate;
    const currentDigest = workflow.stepDigests[entry.stepId];
    const currentStructuralDigest =
      workflow.stepStructuralDigests[entry.stepId];
    const shouldRefresh =
      gate !== undefined &&
      typeof currentDigest === 'string' &&
      currentDigest.length > 0 &&
      typeof currentStructuralDigest === 'string' &&
      currentStructuralDigest.length > 0 &&
      entry.outcome === gate.approvedOutcome &&
      entry.approval?.stepStructuralDigest === currentStructuralDigest &&
      entry.stepDigest !== currentDigest;
    return shouldRefresh ? { ...entry, stepDigest: currentDigest } : entry;
  });
  const hasChanged = history.some(
    (entry, index) => entry !== run.history[index],
  );
  return hasChanged ? { ...run, history } : run;
};
