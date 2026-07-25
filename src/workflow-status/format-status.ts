import { DEFAULT_STATUS_SHORTCUT } from '../config/types.ts';
import { formatShortcutLabel } from './formatting.ts';
import { renderBoard } from './render-board.ts';
import type { WorkflowStatusSnapshot, WorkflowStatusTheme } from './types.ts';

const UNSTYLED_THEME = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as const satisfies WorkflowStatusTheme;

/** Format a plain-text workflow status suitable for fallback notifications. */
export function formatWorkflowStatusText(
  snapshot: WorkflowStatusSnapshot,
): string {
  const { run } = snapshot;
  const lines = [
    `Workflow: ${run.workflowId}`,
    `Run: ${run.runId}`,
    `Status: ${run.status}`,
    `Step: ${run.currentStepId}`,
    `Completed steps: ${run.history.length}`,
  ];
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
