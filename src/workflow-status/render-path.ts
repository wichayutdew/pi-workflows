import { truncateToWidth } from '@earendil-works/pi-tui';
import type { LoadedWorkflow } from '../config/types.ts';
import type { StepHistoryEntry } from '../engine/state.ts';
import {
  inline,
  runDisplayStatus,
  statusColor,
  statusGlyph,
  statusLabel,
  stepTitle,
} from './formatting.ts';
import { joinColumns, padAnsi } from './layout.ts';
import { formatUsd } from './format-usage.ts';
import type {
  PathEntry,
  WorkflowStatusSnapshot,
  WorkflowStatusTheme,
} from './types.ts';

const MAX_PATH_ROWS = 16;

function historyPathEntry(
  workflow: LoadedWorkflow | undefined,
  entry: StepHistoryEntry,
  visit: number,
  index: number,
): PathEntry {
  return {
    index,
    historyIndex: index,
    stepId: entry.stepId,
    title: stepTitle(workflow, entry.stepId),
    status: 'completed',
    visit,
    outcome: entry.outcome,
    ...(entry.usage ? { usage: entry.usage } : {}),
    isCurrent: false,
  };
}

/** Build immutable display entries from completed history and current state. */
export function buildPathEntries(
  snapshot: WorkflowStatusSnapshot,
): Array<PathEntry> {
  const { run, workflow } = snapshot;
  const visits = new Map<string, number>();
  const completedEntries = run.history.map((entry, index) => {
    const visit = (visits.get(entry.stepId) ?? 0) + 1;
    visits.set(entry.stepId, visit);
    return historyPathEntry(workflow, entry, visit, index);
  });

  if (run.status !== 'completed') {
    return [
      ...completedEntries,
      {
        index: completedEntries.length,
        stepId: run.currentStepId,
        title: stepTitle(workflow, run.currentStepId),
        status: runDisplayStatus(run),
        visit: Math.max(
          visits.get(run.currentStepId) ?? 0,
          run.visits[run.currentStepId] ?? 1,
        ),
        ...(run.currentStepUsage ? { usage: run.currentStepUsage } : {}),
        isCurrent: true,
      },
    ];
  }
  if (
    completedEntries.length === 0 ||
    completedEntries.at(-1)?.stepId !== run.currentStepId
  ) {
    return [
      ...completedEntries,
      {
        index: completedEntries.length,
        stepId: run.currentStepId,
        title: stepTitle(workflow, run.currentStepId),
        status: 'completed',
        visit: Math.max(1, run.visits[run.currentStepId] ?? 1),
        ...(run.currentStepUsage ? { usage: run.currentStepUsage } : {}),
        isCurrent: true,
      },
    ];
  }
  return completedEntries;
}

/** Render the execution-path panel for a workflow snapshot. */
export function renderPathLines(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
  selectedIndex?: number,
): Array<string> {
  const entries = buildPathEntries(snapshot);
  if (entries.length === 0) {
    return [theme.fg('muted', 'No step attempts recorded')];
  }

  const selection = Math.max(
    0,
    Math.min(selectedIndex ?? entries.length - 1, entries.length - 1),
  );
  const maximumStart = Math.max(0, entries.length - MAX_PATH_ROWS);
  const windowStart = Math.max(
    0,
    Math.min(selection - Math.floor(MAX_PATH_ROWS / 2), maximumStart),
  );
  const hidden = windowStart;
  const hiddenAfter = Math.max(0, entries.length - windowStart - MAX_PATH_ROWS);
  const prefix =
    hidden > 0
      ? [
          theme.fg(
            'dim',
            `… ${hidden} earlier attempt${hidden === 1 ? '' : 's'}`,
          ),
        ]
      : [];
  const visibleRows = entries
    .slice(windowStart, windowStart + MAX_PATH_ROWS)
    .map((entry) => {
      const visit =
        entry.visit > 1 ? theme.fg('dim', ` · visit ${entry.visit}`) : '';
      const left = `${statusGlyph(theme, entry.status, snapshot.now)} ${theme.fg(
        entry.isCurrent ? 'text' : 'muted',
        entry.title,
      )}${visit}`;
      const cost = entry.usage?.models.length
        ? ` · ${formatUsd(entry.usage.usage.totalCostUsd)}`
        : '';
      const right = entry.outcome
        ? `${statusLabel(entry.status)} · ${inline(entry.outcome)}${cost}`
        : `${statusLabel(entry.status)}${cost}`;
      const row = joinColumns(
        left,
        theme.fg(statusColor(entry.status), right),
        width,
        Math.max(12, Math.floor(width * 0.58)),
      );
      return entry.index === selection
        ? theme.bg('selectedBg', padAnsi(row, width))
        : truncateToWidth(row, width);
    });
  const suffix =
    hiddenAfter > 0
      ? [
          theme.fg(
            'dim',
            `… ${hiddenAfter} later attempt${hiddenAfter === 1 ? '' : 's'}`,
          ),
        ]
      : [];
  return [...prefix, ...visibleRows, ...suffix];
}
