import { truncateToWidth } from '@earendil-works/pi-tui';
import {
  elapsedMs,
  formatElapsed,
  formatExecution,
  formatStepName,
  formatTimestamp,
  inline,
  runDisplayStatus,
  statusBadge,
  statusColor,
  statusGlyph,
  statusLabel,
  stepTitle,
} from './formatting.ts';
import { clampRows, keyValueLines } from './layout.ts';
import { formatUsage, workflowUsage } from './format-usage.ts';
import type { WorkflowStatusSnapshot, WorkflowStatusTheme } from './types.ts';

const MAX_REASON_ROWS = 5;

/** Render the two compact lines in the workflow status header. */
export function renderHeaderLines(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): Array<string> {
  const { run } = snapshot;
  const command = snapshot.workflow?.definition.command;
  const firstLine = [
    statusGlyph(theme, runDisplayStatus(run), snapshot.now),
    theme.bold(inline(run.workflowId)),
    ...(command ? [theme.fg('accent', `/${inline(command)}`)] : []),
    statusBadge(theme, run.status),
    theme.fg('muted', '·'),
    theme.fg(
      'success',
      `${run.history.length} completed attempt${run.history.length === 1 ? '' : 's'}`,
    ),
  ].join(' ');

  const currentTitle = stepTitle(snapshot.workflow, run.currentStepId);
  const visit = Math.max(1, run.visits[run.currentStepId] ?? 1);
  const secondLine = [
    theme.fg('muted', 'step'),
    theme.fg('text', formatStepName(currentTitle, run.currentStepId)),
    theme.fg(
      'muted',
      `· visit ${visit} · elapsed ${formatElapsed(elapsedMs(snapshot))}`,
    ),
  ].join(' ');

  return [
    truncateToWidth(firstLine, width),
    truncateToWidth(secondLine, width),
  ];
}

/** Render the key/value summary panel for a workflow snapshot. */
export function renderSummaryLines(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): Array<string> {
  const { run, workflow } = snapshot;
  const lines = [
    ...keyValueLines(theme, 'workflow', run.workflowId, width),
    ...(workflow
      ? [
          ...keyValueLines(
            theme,
            'command',
            `/${workflow.definition.command}`,
            width,
            'accent',
          ),
          ...keyValueLines(
            theme,
            'about',
            workflow.definition.description,
            width,
          ),
        ]
      : []),
    ...keyValueLines(theme, 'run', run.runId, width),
    ...(run.iteration && run.iteration > 1
      ? [...keyValueLines(theme, 'iteration', String(run.iteration), width)]
      : []),
    ...keyValueLines(
      theme,
      'status',
      statusLabel(run.status),
      width,
      statusColor(run.status),
    ),
    ...keyValueLines(
      theme,
      'current',
      formatStepName(stepTitle(workflow, run.currentStepId), run.currentStepId),
      width,
    ),
    ...keyValueLines(
      theme,
      'visit',
      String(Math.max(1, run.visits[run.currentStepId] ?? 1)),
      width,
    ),
    ...keyValueLines(theme, 'started', formatTimestamp(run.startedAt), width),
    ...keyValueLines(
      theme,
      'updated',
      `${formatTimestamp(run.updatedAt)} · ${formatElapsed(elapsedMs(snapshot))}`,
      width,
    ),
  ];

  const usage = workflowUsage(run);
  if (usage.models.length > 0) {
    lines.push(...keyValueLines(theme, 'usage', formatUsage(usage), width));
    lines.push(
      ...usage.models.flatMap((entry) =>
        keyValueLines(
          theme,
          'model',
          `${entry.provider}/${entry.model} · ${formatUsage({ usage: entry.usage, models: [] })}`,
          width,
          'muted',
        ),
      ),
    );
  }
  if (run.cwd && run.startCwd && run.cwd !== run.startCwd) {
    lines.push(...keyValueLines(theme, 'workspace', run.cwd, width, 'accent'));
  }
  const execution = formatExecution(snapshot.execution);
  if (execution) {
    lines.push(
      ...keyValueLines(theme, 'execution', execution, width, 'accent'),
    );
  }
  if (run.pendingGate) {
    const review = run.pendingGate.reviewId
      ? `${run.pendingGate.provider} · ${run.pendingGate.reviewId}`
      : `${run.pendingGate.provider} · opening`;
    lines.push(...keyValueLines(theme, 'review', review, width, 'warning'));
  }
  if (!workflow) {
    lines.push(
      ...keyValueLines(
        theme,
        'config',
        'workflow definition is not loaded',
        width,
        'warning',
      ),
    );
  } else if (workflow.digest !== run.workflowDigest) {
    lines.push(
      ...keyValueLines(
        theme,
        'config',
        'definition changed since this checkpoint',
        width,
        'warning',
      ),
    );
  }
  if (run.pauseReason) {
    lines.push(
      ...clampRows(
        keyValueLines(
          theme,
          'reason',
          run.pauseReason,
          width,
          run.status === 'aborted' ? 'error' : 'warning',
        ),
        MAX_REASON_ROWS,
        width,
        theme,
      ),
    );
  }
  return lines;
}
