import { boxed, joinPanels } from './layout.ts';
import { renderPathLines } from './render-path.ts';
import { renderHeaderLines, renderSummaryLines } from './render-summary.ts';
import type { WorkflowStatusSnapshot, WorkflowStatusTheme } from './types.ts';

const WIDE_LAYOUT_MIN_COLUMNS = 92;

/** Render the complete workflow status board without terminal pagination. */
export function renderBoard(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
  shouldShowCloseHint: boolean,
  statusShortcutLabel: string,
  selectedIndex?: number,
): Array<string> {
  const header = boxed(
    theme,
    '✦ Workflow Status',
    width,
    renderHeaderLines(theme, snapshot, width - 4),
    'borderAccent',
  );

  const body =
    width >= WIDE_LAYOUT_MIN_COLUMNS
      ? renderWideBody(theme, snapshot, width, selectedIndex)
      : renderNarrowBody(theme, snapshot, width, selectedIndex);
  const lines = [...header, '', ...body];
  return shouldShowCloseHint
    ? [
        ...lines,
        '',
        theme.fg('dim', `${statusShortcutLabel} / q / Esc hide · live refresh`),
      ]
    : lines;
}

function renderWideBody(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
  selectedIndex?: number,
): Array<string> {
  const gap = 2;
  const summaryWidth = Math.min(42, Math.max(36, Math.floor(width * 0.36)));
  const pathWidth = width - summaryWidth - gap;
  const summary = boxed(
    theme,
    'Run Summary',
    summaryWidth,
    renderSummaryLines(theme, snapshot, summaryWidth - 4),
  );
  const path = boxed(
    theme,
    'Execution Path',
    pathWidth,
    renderPathLines(theme, snapshot, pathWidth - 4, selectedIndex),
    'borderAccent',
  );
  return joinPanels(summary, summaryWidth, path, pathWidth, gap);
}

function renderNarrowBody(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
  selectedIndex?: number,
): Array<string> {
  return [
    ...boxed(
      theme,
      'Run Summary',
      width,
      renderSummaryLines(theme, snapshot, width - 4),
    ),
    '',
    ...boxed(
      theme,
      'Execution Path',
      width,
      renderPathLines(theme, snapshot, width - 4, selectedIndex),
      'borderAccent',
    ),
  ];
}

/** Render the empty state shown before a workflow checkpoint exists. */
export function renderEmptyBoard(
  theme: WorkflowStatusTheme,
  width: number,
): Array<string> {
  return [
    ...boxed(
      theme,
      '✦ Workflow Status',
      width,
      [theme.fg('muted', 'No workflow checkpoint in this session')],
      'borderAccent',
    ),
    '',
    theme.fg('dim', 'q / Esc close'),
  ];
}
