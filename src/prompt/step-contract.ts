import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { allowedOutcomes } from '../engine/transitions.ts';

/**
 * Render-ready completion constraints for one workflow step.
 */
export type StepContract = {
  readonly outcomes: ReadonlyArray<string>;
  readonly transitionLines: string;
  readonly gateLine: string;
  readonly recoveryInstructions: ReadonlyArray<string>;
};

type CreateStepContractOptions = {
  readonly workflow: LoadedWorkflow;
  readonly run: WorkflowRun;
  readonly step: WorkflowStep;
};

const pauseOutcomesFor = (
  step: WorkflowStep,
  allowedOutcomeSet: ReadonlySet<string>,
): ReadonlyArray<string> =>
  Object.entries(step.transitions)
    .filter(
      ([outcome, target]) =>
        target === '$pause' && allowedOutcomeSet.has(outcome),
    )
    .map(([outcome]) => outcome);

type RecoveryInstructionsOptions = {
  readonly allowedOutcomeSet: ReadonlySet<string>;
  readonly pauseOutcomes: ReadonlyArray<string>;
};

const buildRecoveryInstructions = ({
  allowedOutcomeSet,
  pauseOutcomes,
}: RecoveryInstructionsOptions): ReadonlyArray<string> => {
  const retryInstruction = allowedOutcomeSet.has('retry')
    ? [
        'Use outcome `retry` when the execution contract remains valid and another bounded fresh attempt can safely continue from inspected state. Include the exact failure, attempts, observed state, and next alternative in `summary`.',
      ]
    : [];
  const replanInstruction = allowedOutcomeSet.has('replan')
    ? [
        'Use outcome `replan` when recovery requires a material change to reviewed intent, commands, targets, or authority. Include the exact invalid contract evidence and proposed correction in `summary`.',
      ]
    : [];

  if (pauseOutcomes.length > 0) {
    return [
      ...retryInstruction,
      ...replanInstruction,
      `Use a pause outcome (${pauseOutcomes.join(', ')}) only when permitted alternatives and offered recovery outcomes cannot resolve the workflow definition, environment, or execution contract. Describe the exhausted recovery evidence declaratively in \`summary\`.`,
    ];
  }
  if (allowedOutcomeSet.has('retry') || allowedOutcomeSet.has('replan')) {
    return [...retryInstruction, ...replanInstruction];
  }

  return [
    ...retryInstruction,
    ...replanInstruction,
    'If the workflow definition, environment, or final execution contract is wrong, do not fabricate success or call the completion tool; end with a concise declarative error so the harness pauses the step.',
  ];
};

/**
 * Derives the completion and recovery contract for an active workflow step.
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
  const pauseOutcomes = pauseOutcomesFor(step, allowedOutcomeSet);
  const transitionLines = Object.entries(step.transitions)
    .filter(([outcome]) => allowedOutcomeSet.has(outcome))
    .map(([outcome, target]) => `- ${outcome}: ${target}`)
    .join('\n');
  const gateLine = step.gate
    ? `- ${step.gate.submitOutcome}: submit the artifact to ${step.gate.provider}; include the full artifact argument`
    : '';

  return {
    outcomes,
    transitionLines,
    gateLine,
    recoveryInstructions: buildRecoveryInstructions({
      allowedOutcomeSet,
      pauseOutcomes,
    }),
  };
}
