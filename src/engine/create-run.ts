import type { LoadedWorkflow } from '../config/types.ts';
import { RUN_STATE_VERSION } from './state-types.ts';
import type { WorkflowRun } from './state-types.ts';

/**
 * Creates the immutable initial state for a workflow run.
 *
 * @param workflow - Loaded workflow definition and digests.
 * @param input - User input that started the workflow.
 * @param baselineTools - Tool names available before workflow restrictions.
 * @param runId - Stable run identifier.
 * @param now - Creation timestamp.
 * @param cwd - Canonical working directory captured at workflow start.
 * @param iteration - One-based restart iteration within this worktree lineage.
 * @returns A new running workflow state.
 */
export const createRun = (
  workflow: LoadedWorkflow,
  input: string,
  baselineTools: ReadonlyArray<string>,
  runId: string,
  now: number,
  cwd?: string,
  iteration = 1,
): WorkflowRun => {
  const startStepId = workflow.definition.start;
  return {
    stateVersion: RUN_STATE_VERSION,
    iteration,
    runId,
    workflowId: workflow.definition.id,
    workflowDigest: workflow.digest,
    input,
    status: 'running',
    currentStepId: startStepId,
    currentStepDigest: workflow.stepDigests[startStepId] ?? '',
    baselineTools: [...new Set(baselineTools)],
    visits: { [startStepId]: 1 },
    history: [],
    startedAt: now,
    updatedAt: now,
    reviewedArtifact: '',
    reviewedFeedback: '',
    ...(cwd ? { startCwd: cwd, cwd } : {}),
    stepHandoff: '',
    lastSummary: '',
    gateArtifact: '',
    gateFeedback: '',
  };
};
