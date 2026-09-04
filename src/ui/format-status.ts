import { DEFAULT_STATUS_SHORTCUT } from '../domain/index.ts';
import {
  formatShortcutLabel,
  formatStepName,
  stepTitle,
  workflowStatusIcon,
} from './formatting.ts';
import { renderBoard } from './render-board.ts';
import { formatUsage, workflowUsage } from './format-usage.ts';
import type { WorkflowStatusSnapshot, WorkflowStatusTheme } from './types.ts';

const UNSTYLED_THEME = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as const satisfies WorkflowStatusTheme;

/** Format the persistent main-UI progress line for a running workflow. */
export function formatWorkflowProgressStatus(
  snapshot: WorkflowStatusSnapshot,
  statusShortcutLabel: string,
): string {
  const { run, workflow } = snapshot;
  const currentStep = formatStepName(
    stepTitle(workflow, run.currentStepId),
    run.currentStepId,
  );
  const activity =
    run.status === 'awaiting-gate' ? 'awaiting review' : 'working';
  const workerModel =
    snapshot.execution?.kind === 'subagent' && snapshot.execution.model
      ? ` · model ${snapshot.execution.model}`
      : '';
  const workerProgress =
    snapshot.execution?.kind === 'subagent'
      ? ` · ${snapshot.execution.progress}`
      : '';
  const usage = workflowUsage(run);
  const usageText = usage.models.length > 0 ? ` · ${formatUsage(usage)}` : '';
  return `${workflowStatusIcon(run, snapshot.now)} ${run.workflowId} · step ${currentStep} · ${activity}${workerModel}${workerProgress}${usageText} · ${statusShortcutLabel}`;
}

/** Format a plain-text workflow status suitable for fallback notifications. */
export function formatWorkflowStatusText(
  snapshot: WorkflowStatusSnapshot,
): string {
  const { run, workflow } = snapshot;
  const lines = [
    `Workflow ID: ${run.workflowId}`,
    ...(workflow
      ? [
          `Command: /${workflow.definition.command}`,
          `Description: ${workflow.definition.description}`,
        ]
      : []),
    `Run: ${run.runId}`,
    `Status: ${run.status}`,
    `Step: ${run.currentStepId}`,
    `Completed steps: ${run.history.length}`,
    ...(workflowUsage(run).models.length > 0
      ? [`Usage: ${formatUsage(workflowUsage(run))}`]
      : []),
  ];
  if (run.cwd && run.startCwd && run.cwd !== run.startCwd) {
    lines.push(`Workspace: ${run.cwd}`);
  }
  if (run.pendingGate?.reviewId) {
    lines.push(`Review: ${run.pendingGate.reviewId}`);
  }
  if (snapshot.execution?.kind === 'subagent') {
    lines.push(
      `Subagent: ${snapshot.execution.agent} (${snapshot.execution.requestId})`,
      `Progress: ${snapshot.execution.progress}`,
    );
  } else if (snapshot.execution?.kind === 'main') {
    lines.push('Execution: main agent');
  }
  if (run.pauseReason) lines.push(`Reason: ${run.pauseReason}`);
  return lines.join('\n');
}

/** Format the full workflow status board at a requested visible width. */
export function formatWorkflowStatusBoard(
  snapshot: WorkflowStatusSnapshot,
  width = 88,
  theme: WorkflowStatusTheme = UNSTYLED_THEME,
): Array<string> {
  return renderBoard(
    theme,
    snapshot,
    Math.max(8, Math.floor(width)),
    false,
    formatShortcutLabel(DEFAULT_STATUS_SHORTCUT),
  );
}
