import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';

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
 * Retains reviewed authority only when its approving history remains.
 *
 * @param workflow - Updated workflow.
 * @param run - Existing workflow state.
 * @param history - History retained after reconciliation.
 * @returns The retained artifact, or an empty string when provenance was lost.
 */
export const retainedReviewedArtifact = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  history: ReadonlyArray<StepHistoryEntry>,
): string => {
  const reviewedArtifact = run.reviewedArtifact ?? '';
  if (!reviewedArtifact) return '';

  const isApprovalRetained = history.some((entry) => {
    const gate = workflow.definition.steps[entry.stepId]?.gate;
    return (
      gate !== undefined &&
      entry.outcome === gate.approvedOutcome &&
      entry.summary === reviewedArtifact
    );
  });
  return isApprovalRetained ? reviewedArtifact : '';
};

/**
 * Refreshes the digest of retained approved-gate history.
 *
 * The reviewed artifact itself proves the gate output is unchanged, allowing a
 * prompt-only configuration refresh without discarding approved authority.
 *
 * @param run - Existing workflow state.
 * @param workflow - Updated workflow.
 * @returns A run with refreshed history when needed.
 */
export const refreshApprovedGateHistory = (
  run: WorkflowRun,
  workflow: LoadedWorkflow,
): WorkflowRun => {
  const reviewedArtifact = run.reviewedArtifact ?? '';
  if (!reviewedArtifact) return run;

  const history = run.history.map((entry) => {
    const gate = workflow.definition.steps[entry.stepId]?.gate;
    const currentDigest = workflow.stepDigests[entry.stepId];
    const shouldRefresh =
      gate !== undefined &&
      typeof currentDigest === 'string' &&
      currentDigest.length > 0 &&
      entry.outcome === gate.approvedOutcome &&
      entry.summary === reviewedArtifact &&
      entry.stepDigest !== currentDigest;
    return shouldRefresh ? { ...entry, stepDigest: currentDigest } : entry;
  });
  const hasChanged = history.some(
    (entry, index) => entry !== run.history[index],
  );
  return hasChanged ? { ...run, history } : run;
};
