import type { KeyId } from '@earendil-works/pi-tui';
import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import type {
  StepDisplayStatus,
  WorkflowStatusExecution,
  WorkflowStatusSnapshot,
  WorkflowStatusTheme,
  WorkflowStatusThemeColor,
} from './types.ts';

const WORKING_ICON_FRAME_MS = 250;
const WORKING_ICON_FRAMES = ['◐', '◓', '◑', '◒'] as const;

const SHORTCUT_LABELS: ReadonlyMap<string, string> = new Map([
  ['ctrl', 'Ctrl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['super', 'Super'],
  ['escape', 'Esc'],
  ['esc', 'Esc'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['space', 'Space'],
  ['backspace', 'Backspace'],
  ['delete', 'Del'],
  ['insert', 'Ins'],
  ['clear', 'Clear'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageUp', 'PgUp'],
  ['pageDown', 'PgDn'],
  ['up', 'Up'],
  ['down', 'Down'],
  ['left', 'Left'],
  ['right', 'Right'],
]);

function workingIcon(now: number): string {
  const frame =
    WORKING_ICON_FRAMES[
      Math.floor(now / WORKING_ICON_FRAME_MS) % WORKING_ICON_FRAMES.length
    ];
  return frame ?? WORKING_ICON_FRAMES[0];
}

/** Format a Pi key identifier for display in status help text. */
export function formatShortcutLabel(shortcut: KeyId): string {
  return shortcut
    .split('+')
    .map((part) => {
      const label = SHORTCUT_LABELS.get(part);
      if (label) return label;
      if (/^f\d+$/.test(part)) return part.toUpperCase();
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join('+');
}

/** Render the colored glyph for one workflow step display state. */
export function statusGlyph(
  theme: WorkflowStatusTheme,
  status: StepDisplayStatus,
  now: number,
): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'running') return theme.fg('accent', workingIcon(now));
  if (status === 'paused' || status === 'awaiting-gate') {
    return theme.fg('warning', '◆');
  }
  return theme.fg('error', '✕');
}

/** Select the theme color associated with a workflow display state. */
export function statusColor(
  status: StepDisplayStatus,
): WorkflowStatusThemeColor {
  if (status === 'completed') return 'success';
  if (status === 'running') return 'accent';
  if (status === 'paused' || status === 'awaiting-gate') return 'warning';
  return 'error';
}

/** Format a workflow display state as an uppercase human label. */
export function statusLabel(status: StepDisplayStatus): string {
  return status === 'awaiting-gate'
    ? 'AWAITING REVIEW'
    : status.toUpperCase().replaceAll('-', ' ');
}

/** Render a colored, bracketed workflow status badge. */
export function statusBadge(
  theme: WorkflowStatusTheme,
  status: StepDisplayStatus,
): string {
  return theme.fg(statusColor(status), theme.bold(`[${statusLabel(status)}]`));
}

/** Derive the visible status, including a paused current-step failure. */
export function runDisplayStatus(run: WorkflowRun): StepDisplayStatus {
  return run.status === 'paused' && run.failedStepId === run.currentStepId
    ? 'failed'
    : run.status;
}

/** Return the compact icon used by the persistent workflow status line. */
export function workflowStatusIcon(run: WorkflowRun, now = Date.now()): string {
  const status = runDisplayStatus(run);
  if (status === 'completed') return '✓';
  if (status === 'running') return workingIcon(now);
  if (status === 'failed' || status === 'aborted') return '✕';
  return '◆';
}

/** Resolve and normalize a step title from a loaded workflow definition. */
export function stepTitle(
  workflow: LoadedWorkflow | undefined,
  stepId: string,
): string {
  return inline(workflow?.definition.steps[stepId]?.title ?? stepId);
}

/** Combine a display title and identifier without repeating identical text. */
export function formatStepName(title: string, stepId: string): string {
  const safeStepId = inline(stepId);
  return title === safeStepId ? title : `${title} (${safeStepId})`;
}

/** Format the currently active execution adapter. */
export function formatExecution(
  execution: WorkflowStatusExecution | undefined,
): string | undefined {
  if (!execution) return undefined;
  if (execution.kind === 'main') return 'main agent';
  return `${execution.agent} · ${execution.progress} · ${execution.requestId}`;
}

/** Collapse arbitrary whitespace for safe single-line status rendering. */
export function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Derive elapsed run time from an immutable status snapshot. */
export function elapsedMs(snapshot: WorkflowStatusSnapshot): number {
  const { run } = snapshot;
  const end =
    run.status === 'running' || run.status === 'awaiting-gate'
      ? snapshot.now
      : run.updatedAt;
  return Math.max(0, end - run.startedAt);
}

/** Format elapsed milliseconds using the two most useful time units. */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Format a local timestamp for the workflow status board. */
export function formatTimestamp(milliseconds: number): string {
  const value = new Date(milliseconds);
  if (!Number.isFinite(value.getTime())) return 'unknown';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
