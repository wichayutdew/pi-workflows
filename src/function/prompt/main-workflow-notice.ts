import type { LoadedWorkflow, WorkflowRun } from '../../domain/index.ts';

/**
 * Builds the system notice that distinguishes main-agent work from delegated
 * child work.
 *
 * @param workflow - Loaded workflow definition.
 * @param run - Current workflow run.
 * @param statusShortcutLabel - Human-readable workflow-status shortcut.
 * @returns The active-workflow notice.
 */
export function buildMainWorkflowNotice(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  statusShortcutLabel = 'Ctrl+Alt+W',
): string {
  const step = workflow.definition.steps[run.currentStepId];
  if (!step) {
    throw new Error(`unknown workflow step "${run.currentStepId}"`);
  }

  return [
    '# Active workflow',
    '',
    `Workflow "${workflow.definition.id}" is running step "${run.currentStepId}" (${step.title}) in this session.`,
    ...(step.agent
      ? [`Apply the "${step.agent.name}" workflow role prompt.`]
      : []),
    'Perform only the active workflow step with its allowed resources.',
    'Call `workflow_complete_step` exactly once when finished.',
    `Use \`${statusShortcutLabel}\` or \`/workflow-status\` to inspect status, or \`/workflow-pause\` to halt and repair the workflow before resuming.`,
  ].join('\n');
}
