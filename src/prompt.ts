import type { LoadedWorkflow, WorkflowStep } from './config/types.ts';
import type { WorkflowRun } from './engine/state.ts';
import { allowedOutcomes } from './engine/transitions.ts';

interface TemplateValues {
  [key: string]: string;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function currentStepHandoff(run: WorkflowRun): string {
  const incoming = run.stepHandoff ?? '';
  if (!incoming || incoming === run.lastSummary) return run.lastSummary;
  if (!run.lastSummary) return incoming;
  return [
    'Incoming approved or previous-step handoff:',
    incoming,
    '',
    'Latest paused attempt:',
    run.lastSummary,
  ].join('\n');
}

export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    return values[name] ?? '';
  });
}

function templateValues(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  step: WorkflowStep,
): TemplateValues {
  return {
    'workflow.input': run.input,
    'workflow.id': workflow.definition.id,
    'run.id': run.runId,
    'step.id': run.currentStepId,
    'step.title': step.title,
    'last.summary': currentStepHandoff(run),
    'gate.feedback': run.gateFeedback,
  };
}

function buildStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  execution: 'delegated' | 'main',
  policyEnvelope?: string,
): string {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) throw new Error(`unknown workflow step "${run.currentStepId}"`);
  const promptTemplate = workflow.prompts[run.currentStepId] ?? '';
  const handoff = currentStepHandoff(run);
  const values = templateValues(workflow, run, step);
  if (
    execution === 'delegated' &&
    /\{\{\s*last\.summary\s*\}\}/.test(promptTemplate)
  ) {
    values['last.summary'] =
      '(Provided once in the Previous step handoff section below.)';
  }
  const prompt = renderTemplate(promptTemplate, values);
  const outcomes = allowedOutcomes(workflow, run);
  const allowedOutcomeSet = new Set(outcomes);
  const pauseOutcomes = Object.entries(step.transitions)
    .filter(
      ([outcome, target]) =>
        target === '$pause' && allowedOutcomeSet.has(outcome),
    )
    .map(([outcome]) => outcome);
  const invalidContractInstruction =
    pauseOutcomes.length > 0
      ? `If the workflow definition, environment, or final execution contract is wrong, use a pause outcome (${pauseOutcomes.join(', ')}) and describe the evidence declaratively in \`summary\`.`
      : 'If the workflow definition, environment, or final execution contract is wrong, do not fabricate success or call the completion tool; end with a concise declarative error so the harness pauses the step.';
  const transitionLines = Object.entries(step.transitions)
    .filter(([outcome]) => allowedOutcomeSet.has(outcome))
    .map(([outcome, target]) => `- ${outcome}: ${target}`)
    .join('\n');
  const gateLine = step.gate
    ? `- ${step.gate.submitOutcome}: submit the artifact to ${step.gate.provider}; include the full artifact argument`
    : '';
  const delegated = execution === 'delegated';

  return [
    ...(policyEnvelope ? [policyEnvelope, ''] : []),
    `# ${delegated ? 'Delegated' : 'Main-agent'} declarative workflow step`,
    '',
    `Workflow: ${workflow.definition.id}`,
    `Run: ${run.runId}`,
    `Step: ${run.currentStepId} (${step.title})`,
    ...(delegated
      ? [
          `Step specialty: ${step.subagent?.agent ?? 'generalist'}`,
          'Context: fresh workflow-step context; no parent or sibling transcript is inherited.',
        ]
      : []),
    '',
    '## Step instructions',
    '',
    prompt,
    '',
    ...(delegated
      ? [
          '## Previous step handoff',
          '',
          handoff || '(none; this is the first workflow step)',
          '',
        ]
      : []),
    `## Enforced ${delegated ? 'child' : 'step'} resources`,
    '',
    `Pi tools: ${formatList(step.permissions.tools)}`,
    `MCP selectors: ${formatList(step.permissions.mcp)}`,
    `Extension selectors: ${formatList(step.permissions.extensions)}`,
    `Skills: ${formatList(step.permissions.skills)}`,
    `Bash policy: ${step.permissions.bash.mode}`,
    '',
    `Use only the listed skills for this step. Tool calls are enforced ${delegated ? 'inside this child process' : 'by the workflow harness'}.`,
    '',
    '## Completion contract',
    '',
    `Call \`workflow_complete_step\` exactly once, after all work for this ${delegated ? 'delegated' : 'main-agent'} step is complete.`,
    `Valid outcomes: ${outcomes.join(', ')}`,
    transitionLines,
    gateLine,
    '',
    'Put a self-contained compact handoff in `summary`; this is the only step context passed to the next fresh child.',
    ...(delegated
      ? [
          'This child is non-interactive. Never call `contact_supervisor`, `subagent_supervisor`, or `intercom`.',
          ...(step.gate
            ? [
                'Put every unresolved decision in the gate artifact with evidence, options, a recommendation, and an adopted default; do not ask a terminal question.',
              ]
            : [
                'Treat the step instructions and incoming handoff as the final execution contract; do not ask a terminal question.',
              ]),
        ]
      : []),
    'Do not call the completion tool alongside other tool calls.',
    invalidContractInstruction,
  ].join('\n');
}

export function buildDelegatedStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  policyEnvelope: string,
): string {
  return buildStepTask(workflow, run, 'delegated', policyEnvelope);
}

export function buildMainStepTask(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): string {
  return buildStepTask(workflow, run, 'main');
}

export function buildMainWorkflowNotice(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
): string {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) throw new Error(`unknown workflow step "${run.currentStepId}"`);
  if (!step.subagent) {
    return [
      '# Active main-agent workflow',
      '',
      `Workflow "${workflow.definition.id}" is running step "${run.currentStepId}" (${step.title}) in this session.`,
      'Perform only the active workflow step with its allowed resources.',
      'Call `workflow_complete_step` exactly once when finished.',
      'Use `/workflow-pause` to halt and repair the workflow before resuming.',
    ].join('\n');
  }
  return [
    '# Active subagent workflow',
    '',
    `Workflow "${workflow.definition.id}" is running step "${run.currentStepId}" (${step.title}) in a separate pi-subagents child process.`,
    'Do not perform the workflow step in this main session.',
    'Use `/workflow-status` to inspect it or `/workflow-pause` to cancel the child and repair the workflow before resuming.',
  ].join('\n');
}
