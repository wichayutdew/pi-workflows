import type {
  LoadedWorkflow,
  WorkflowRun,
  WorkflowStep,
} from '../../domain/index.ts';
import { allowedOutcomes } from '../engine/lifecycle-transitions.ts';

/**
 * Render-ready completion constraints for one workflow step.
 */
export type StepContract = {
  readonly outcomes: ReadonlyArray<string>;
  readonly transitionLines: string;
  readonly gateLine: string;
  readonly workspaceLines: ReadonlyArray<string>;
};

type CreateStepContractOptions = {
  readonly workflow: LoadedWorkflow;
  readonly run: WorkflowRun;
  readonly step: WorkflowStep;
};

/**
 * Derives the completion contract for an active workflow step.
 *
 * @param options - Workflow state used to resolve currently allowed outcomes.
 * @returns Immutable text fragments for the step prompt.
 */
export function createStepContract({
  workflow,
  run,
  step,
}: CreateStepContractOptions): StepContract {
  const outcomes = allowedOutcomes(workflow, run);
  const allowedOutcomeSet = new Set(outcomes);
  const transitionLines = Object.entries(step.transitions)
    .filter(([outcome]) => allowedOutcomeSet.has(outcome))
    .map(([outcome, target]) => `- ${outcome}: ${target}`)
    .join('\n');
  const gateLine = step.gate
    ? `- ${step.gate.submitOutcome}: submit the artifact to ${step.gate.provider}; include the full artifact argument`
    : '';
  const workspaceLines = step.workspace
    ? [
        `Workspace-binding outcomes: ${step.workspace.bindOn.join(', ')}`,
        `For those outcomes, include \`workspace.cwd\` as an absolute directory under one allowed root relative to the run-start directory: ${step.workspace.allowedRoots.join(', ')}`,
        'For every other outcome, omit `workspace`.',
      ]
    : ['This step cannot bind a workspace; omit `workspace`.'];

  return {
    outcomes,
    transitionLines,
    gateLine,
    workspaceLines,
  };
}
