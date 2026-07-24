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
  const prompt = renderTemplate(
    workflow.prompts[run.currentStepId] ?? '',
    templateValues(workflow, run, step),
  );
  const outcomes = allowedOutcomes(workflow, run);
  const allowedOutcomeSet = new Set(outcomes);
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
    '',
    '## Step instructions',
    '',
    prompt,
    '',
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
    'Put a concise handoff in `summary`. Do not call the completion tool alongside other tool calls. If the workflow definition or environment is wrong, use an outcome that transitions to `$pause`.',
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
