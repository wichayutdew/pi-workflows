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
 * @returns A new running workflow state.
 */
export const createRun = (
  workflow: LoadedWorkflow,
  input: string,
  baselineTools: ReadonlyArray<string>,
  runId: string,
  now: number,
): WorkflowRun => {
  const startStepId = workflow.definition.start;
  return {
    stateVersion: RUN_STATE_VERSION,
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
    stepHandoff: '',
    lastSummary: '',
    gateFeedback: '',
  };
};
