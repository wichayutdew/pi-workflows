import { loadAgentProfile } from '../agents/profile.ts';
import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { createStepContract } from './step-contract.ts';
import {
  buildDelegatedCompletionInstructions,
  buildDelegatedHandoffSection,
  buildNonSuccessSummaryInstructions,
  buildRestartWorkspaceSection,
  buildResourceSection,
} from './step-sections.ts';
import {
  createTemplateValues,
  currentStepHandoff,
  renderTemplate,
} from './template.ts';

type StepExecution = 'delegated' | 'main';

const rolePrompt = (name: string): string => loadAgentProfile(name).prompt;

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

const RESUME_INPUT_PLACEHOLDER = /\{\{\s*resume\.input\s*\}\}/;
const WORKFLOW_INPUT_PLACEHOLDER = /\{\{\s*workflow\.input\s*\}\}/;

const renderStepPrompt = ({
  workflow,
  run,
  step,
  execution,
}: RenderStepPromptOptions): string => {
  const promptTemplate = workflow.prompts[run.currentStepId] ?? '';
  const templateValues = createTemplateValues({ workflow, run, step });
  const hidesRepeatedLastSummary =
    execution === 'delegated' &&
    /\{\{\s*last\.summary\s*\}\}/.test(promptTemplate);
  const hidesRepeatedReviewedArtifact =
    execution === 'delegated' &&
    Boolean(run.reviewedArtifact) &&
    /\{\{\s*reviewed\.artifact\s*\}\}/.test(promptTemplate);
  const handoffReference =
    '(Provided once in the Previous step handoff section below.)';
  const values = {
    ...templateValues,
    ...(hidesRepeatedLastSummary ? { 'last.summary': handoffReference } : {}),
    ...(hidesRepeatedReviewedArtifact
      ? {
          'reviewed.artifact':
            '(Provided once in the Approved plan section below.)',
        }
      : {}),
  };

  return renderTemplate(promptTemplate, values);
};

const buildResumeInputSection = (
  run: WorkflowRun,
  promptContainsResumeInput: boolean,
): ReadonlyArray<string> => {
  if (!run.resumeInput) return [];
  const authority =
    'The user-supplied resume guidance for this attempt is authoritative when it conflicts with task instructions in the step prompt or previous handoff. Inspect current state before applying it. It does not change the workflow graph or the YAML-enforced tools, MCP, extensions, skills, Bash policy, or workspace boundary.';
  if (promptContainsResumeInput) {
    return ['## Resume guidance authority', '', authority, ''];
  }
  const serialized = JSON.stringify({ input: run.resumeInput }, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return [
    '## User guidance supplied with `/workflow-resume`',
    '',
    authority,
    '',
    '<pi-workflows-resume-input-v1>',
    serialized,
    '</pi-workflows-resume-input-v1>',
    '',
  ];
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
  const promptTemplate = workflow.prompts[run.currentStepId] ?? '';
  const prompt = renderStepPrompt({ workflow, run, step, execution });
  const showWorkflowInput = WORKFLOW_INPUT_PLACEHOLDER.test(promptTemplate);
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
    `Iteration: ${run.iteration ?? 1}`,
    `Step: ${run.currentStepId} (${step.title})`,
    ...(step.agent ? [`Agent profile: ${step.agent.name}`] : []),
    '',
    '## Step instructions',
    '',
    ...(step.agent
      ? ['## Role prompt', '', rolePrompt(step.agent.name), '']
      : []),
    prompt,
    '',
    ...(run.reviewedArtifact
      ? ['## Approved plan', '', run.reviewedArtifact, '']
      : []),
    ...(showWorkflowInput
      ? ['## Original workflow request', '', run.input || '(none supplied)', '']
      : []),
    ...(isDelegated ? buildDelegatedHandoffSection(handoff) : []),
    ...buildRestartWorkspaceSection(run.restartWorkspaceCwd),
    ...buildResumeInputSection(
      run,
      RESUME_INPUT_PLACEHOLDER.test(promptTemplate),
    ),
    ...buildResourceSection({ execution, step }),
    '## Completion contract',
    '',
    `Call \`${completionTool}\` exactly once, after all work for this ${isDelegated ? 'delegated' : 'main-agent'} step is complete.`,
    `Valid outcomes: ${contract.outcomes.join(', ')}`,
    contract.transitionLines,
    contract.gateLine,
    ...contract.workspaceLines,
    '',
    'Put a self-contained compact handoff in `summary`; this is the only step context passed to the next fresh child.',
    ...(isDelegated
      ? [
          "Evaluate completion and choose an outcome using only this delegated step's instructions.",
          'A later workflow step is not unfinished work in this step and never by itself requires `handoff`.',
          'Limit `Completed` and `Remaining` to this delegated step. When it is complete, state `- No active-step work remains.` under `Remaining`.',
        ]
      : []),
    'For every outcome, use `# <Outcome>: <state>`, then `**Completed:**` and `**Remaining:**` sections with one or more `- ` items. Each completed item must cite a concrete path, command, identifier, or user decision; never use placeholders or generic text.',
    ...(contract.outcomes.includes('blocked')
      ? [
          'For `blocked`, also include `**Question:** <one concrete clarifying question ending in ?>`.',
        ]
      : []),
    'Format all human-facing output—including summaries, gate artifacts, Markdown plans, reports, comments, and replies—for scanning: short headings, then one distinct fact, action, or metadata value per bullet or paragraph. Never pack unrelated values into one line or dense prose.',
    'When a schema needs several related fields, use a bullet list with one `field`: `value` per row; use JSON only for machine-readable data under `## Machine-readable handoff` in a fenced valid `json` block. Keep prose outside that block.',
    ...buildNonSuccessSummaryInstructions(contract.outcomes),
    ...(isDelegated ? buildDelegatedCompletionInstructions() : []),
    'Do not call the completion tool alongside other tool calls.',
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
