import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';

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
    `Use \`${statusShortcutLabel}\` to show or hide the workflow status overlay, or \`/workflow-pause\` to cancel the child and repair the workflow before resuming.`,
  ].join('\n');
}
