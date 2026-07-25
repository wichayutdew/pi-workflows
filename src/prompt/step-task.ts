import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { createStepContract } from './step-contract.ts';
import {
  buildDelegatedCompletionInstructions,
  buildDelegatedHandoffSection,
  buildResourceSection,
} from './step-sections.ts';
import {
  createTemplateValues,
  currentStepHandoff,
  renderTemplate,
} from './template.ts';

type StepExecution = 'delegated' | 'main';

type BuildStepTaskOptions =
  | {
      readonly execution: 'delegated';
      readonly workflow: LoadedWorkflow;
      readonly run: WorkflowRun;
      readonly policyEnvelope: string;
    }
  | {
      readonly execution: 'main';
      readonly workflow: LoadedWorkflow;
      readonly run: WorkflowRun;
    };

const resolveStep = (
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): WorkflowStep => {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) {
    throw new Error(`unknown workflow step "${run.currentStepId}"`);
  }
  return step;
};

type RenderStepPromptOptions = {
  readonly workflow: LoadedWorkflow;
  readonly run: WorkflowRun;
  readonly step: WorkflowStep;
  readonly execution: StepExecution;
};

const renderStepPrompt = ({
  workflow,
  run,
  step,
  execution,
}: RenderStepPromptOptions): string => {
  const promptTemplate = workflow.prompts[run.currentStepId] ?? '';
  const templateValues = createTemplateValues({ workflow, run, step });
  const hidesRepeatedHandoff =
    execution === 'delegated' &&
    /\{\{\s*last\.summary\s*\}\}/.test(promptTemplate);
  const values = hidesRepeatedHandoff
    ? {
        ...templateValues,
        'last.summary':
          '(Provided once in the Previous step handoff section below.)',
      }
    : templateValues;

  return renderTemplate(promptTemplate, values);
};

/**
 * Builds the complete task for either a main-agent or delegated workflow step.
 *
 * @param options - Discriminated execution context for the active step.
 * @returns The workflow-step task prompt.
 */
export function buildStepTask(options: BuildStepTaskOptions): string {
  const { execution, workflow, run } = options;
  const step = resolveStep(workflow, run);
  const isDelegated = execution === 'delegated';
  const prompt = renderStepPrompt({ workflow, run, step, execution });
  const handoff = currentStepHandoff(run);
  const contract = createStepContract({ workflow, run, step });
  const completionTool = isDelegated
    ? 'structured_output'
    : 'workflow_complete_step';
  const policyEnvelope =
    options.execution === 'delegated' ? options.policyEnvelope : '';

  return [
    ...(policyEnvelope ? [policyEnvelope, ''] : []),
    `# ${isDelegated ? 'Delegated' : 'Main-agent'} declarative workflow step`,
    '',
    `Workflow: ${workflow.definition.id}`,
    `Run: ${run.runId}`,
    `Step: ${run.currentStepId} (${step.title})`,
    ...(isDelegated
      ? [
          `Agent profile: ${step.subagent?.agent ?? 'generalist'}`,
          'Context: fresh workflow-step context; no parent or sibling transcript is inherited.',
        ]
      : []),
    '',
    '## Step instructions',
    '',
    prompt,
    '',
    ...(isDelegated ? buildDelegatedHandoffSection(handoff) : []),
    ...buildResourceSection({ execution, step }),
    '## Completion contract',
    '',
    `Call \`${completionTool}\` exactly once, after all work for this ${isDelegated ? 'delegated' : 'main-agent'} step is complete.`,
    `Valid outcomes: ${contract.outcomes.join(', ')}`,
    contract.transitionLines,
    contract.gateLine,
    '',
    'Put a self-contained compact handoff in `summary`; this is the only step context passed to the next fresh child.',
    ...(isDelegated ? buildDelegatedCompletionInstructions(step) : []),
    'Do not call the completion tool alongside other tool calls.',
    ...contract.recoveryInstructions,
  ].join('\n');
}

/**
 * Builds a task for a fresh delegated workflow-step process.
 *
 * @param workflow - Loaded workflow definition and prompts.
 * @param run - Current workflow run.
 * @param policyEnvelope - Enforced child-policy envelope.
 * @returns The delegated task prompt.
 */
export function buildDelegatedStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  policyEnvelope: string,
): string {
  return buildStepTask({
    execution: 'delegated',
    workflow,
    run,
    policyEnvelope,
  });
}

/**
 * Builds a task for execution in the main agent session.
 *
 * @param workflow - Loaded workflow definition and prompts.
 * @param run - Current workflow run.
 * @returns The main-agent task prompt.
 */
export function buildMainStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): string {
  return buildStepTask({ execution: 'main', workflow, run });
}
