import type {
  ExtensionCommandContext,
  Theme,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import type { LoadedWorkflow } from './config/types.ts';
import type {
  StepHistoryEntry,
  WorkflowRun,
  WorkflowRunStatus,
} from './engine/state.ts';

const REFRESH_INTERVAL_MS = 1_000;
const WIDE_LAYOUT_MIN_COLUMNS = 92;
const MAX_PATH_ROWS = 16;

export type WorkflowStatusExecution =
  | {
      kind: 'main';
    }
  | {
      kind: 'subagent';
      agent: string;
      requestId: string;
      progress: string;
    };

export interface WorkflowStatusSnapshot {
  run: WorkflowRun;
  workflow?: LoadedWorkflow;
  execution?: WorkflowStatusExecution;
  now: number;
}

type SnapshotProvider = () => WorkflowStatusSnapshot | undefined;
type StepDisplayStatus = WorkflowRunStatus | 'completed';

interface PathEntry {
  stepId: string;
  title: string;
  status: StepDisplayStatus;
  visit: number;
  outcome?: string;
  current: boolean;
}

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

export async function showWorkflowStatus(
  ctx: ExtensionCommandContext,
  getSnapshot: SnapshotProvider,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const view = new WorkflowStatusView(getSnapshot, tui, theme, done);
    view.start();
    return view;
  });
}

export class WorkflowStatusView implements Component {
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly getSnapshot: SnapshotProvider,
    private readonly tui: Pick<TUI, 'requestRender'>,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {}

  start(): void {
    this.timer = setInterval(
      () => this.tui.requestRender(),
      REFRESH_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (
      data === 'q' ||
      data === 'Q' ||
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      matchesKey(data, 'ctrl+d')
    ) {
      this.close();
    }
  }

  render(width: number): string[] {
    const viewportWidth = Math.max(1, Math.floor(width || 1));
    const snapshot = this.getSnapshot();
    if (viewportWidth < 12) {
      const label = snapshot
        ? `${statusGlyph(this.theme, snapshot.run.status)} ${snapshot.run.workflowId} ${statusLabel(snapshot.run.status)}`
        : 'No workflow';
      return [truncateToWidth(label, viewportWidth, '…', true)];
    }

    const contentWidth = viewportWidth - 2;
    const lines = snapshot
      ? renderBoard(this.theme, snapshot, contentWidth)
      : renderEmptyBoard(this.theme, contentWidth);
    return lines.map((line) =>
      padAnsi(truncateToWidth(line, contentWidth, '…'), viewportWidth),
    );
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.done();
    this.tui.requestRender(true);
  }
}

function renderBoard(
  theme: Theme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): string[] {
  const header = boxed(
    theme,
    '✦ Workflow Status',
    width,
    renderHeaderLines(theme, snapshot, width - 4),
    'borderAccent',
  );

  let body: string[];
  if (width >= WIDE_LAYOUT_MIN_COLUMNS) {
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
      renderPathLines(theme, snapshot, pathWidth - 4),
      'borderAccent',
    );
    body = joinPanels(summary, summaryWidth, path, pathWidth, gap);
  } else {
    body = [
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
        renderPathLines(theme, snapshot, width - 4),
        'borderAccent',
      ),
    ];
  }

  return [
    ...header,
    '',
    ...body,
    '',
    theme.fg('dim', 'q / Esc close · live refresh'),
  ];
}

function renderEmptyBoard(theme: Theme, width: number): string[] {
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

function renderHeaderLines(
  theme: Theme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): string[] {
  const { run } = snapshot;
  const workflowName = inline(run.workflowId);
  const status = statusBadge(theme, run.status);
  const completed = theme.fg(
    'success',
    `${run.history.length} completed attempt${run.history.length === 1 ? '' : 's'}`,
  );
  const firstLine = [
    statusGlyph(theme, run.status),
    theme.bold(workflowName),
    status,
    theme.fg('muted', '·'),
    completed,
  ].join(' ');

  const currentTitle = stepTitle(snapshot.workflow, run.currentStepId);
  const visit = Math.max(1, run.visits[run.currentStepId] ?? 1);
  const elapsed = formatElapsed(elapsedMs(snapshot));
  const secondLine = [
    theme.fg('muted', 'step'),
    theme.fg('text', formatStepName(currentTitle, run.currentStepId)),
    theme.fg('muted', `· visit ${visit} · elapsed ${elapsed}`),
  ].join(' ');

  return [
    truncateToWidth(firstLine, width),
    truncateToWidth(secondLine, width),
  ];
}

function renderSummaryLines(
  theme: Theme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): string[] {
  const { run, workflow } = snapshot;
  const lines = [
    ...keyValueLines(theme, 'workflow', run.workflowId, width),
    ...keyValueLines(theme, 'run', run.runId, width),
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
      ...keyValueLines(
        theme,
        'reason',
        run.pauseReason,
        width,
        run.status === 'aborted' ? 'error' : 'warning',
      ),
    );
  }
  return lines;
}

function renderPathLines(
  theme: Theme,
  snapshot: WorkflowStatusSnapshot,
  width: number,
): string[] {
  const entries = buildPathEntries(snapshot);
  if (entries.length === 0) {
    return [theme.fg('muted', 'No step attempts recorded')];
  }

  const hidden = Math.max(0, entries.length - MAX_PATH_ROWS);
  const visible = entries.slice(hidden);
  const lines =
    hidden > 0
      ? [
          theme.fg(
            'dim',
            `… ${hidden} earlier attempt${hidden === 1 ? '' : 's'}`,
          ),
        ]
      : [];
  for (const entry of visible) {
    const visit =
      entry.visit > 1 ? theme.fg('dim', ` · visit ${entry.visit}`) : '';
    const left = `${statusGlyph(theme, entry.status)} ${theme.fg(
      entry.current ? 'text' : 'muted',
      entry.title,
    )}${visit}`;
    const right = entry.outcome
      ? `${statusLabel(entry.status)} · ${inline(entry.outcome)}`
      : statusLabel(entry.status);
    const row = joinColumns(
      left,
      theme.fg(statusColor(entry.status), right),
      width,
      Math.max(12, Math.floor(width * 0.58)),
    );
    lines.push(
      entry.current
        ? theme.bg('selectedBg', padAnsi(row, width))
        : truncateToWidth(row, width),
    );
  }
  return lines;
}

function buildPathEntries(snapshot: WorkflowStatusSnapshot): PathEntry[] {
  const { run, workflow } = snapshot;
  const visits = new Map<string, number>();
  const entries = run.history.map((entry) => {
    const visit = (visits.get(entry.stepId) ?? 0) + 1;
    visits.set(entry.stepId, visit);
    return historyPathEntry(workflow, entry, visit);
  });

  if (run.status !== 'completed') {
    entries.push({
      stepId: run.currentStepId,
      title: stepTitle(workflow, run.currentStepId),
      status: run.status,
      visit: Math.max(
        visits.get(run.currentStepId) ?? 0,
        run.visits[run.currentStepId] ?? 1,
      ),
      current: true,
    });
  } else if (
    entries.length === 0 ||
    entries.at(-1)?.stepId !== run.currentStepId
  ) {
    entries.push({
      stepId: run.currentStepId,
      title: stepTitle(workflow, run.currentStepId),
      status: 'completed',
      visit: Math.max(1, run.visits[run.currentStepId] ?? 1),
      current: true,
    });
  }
  return entries;
}

function historyPathEntry(
  workflow: LoadedWorkflow | undefined,
  entry: StepHistoryEntry,
  visit: number,
): PathEntry {
  return {
    stepId: entry.stepId,
    title: stepTitle(workflow, entry.stepId),
    status: 'completed',
    visit,
    outcome: entry.outcome,
    current: false,
  };
}

function keyValueLines(
  theme: Theme,
  label: string,
  rawValue: string,
  width: number,
  valueColor: ThemeColor = 'text',
): string[] {
  const safeWidth = Math.max(1, width);
  const labelWidth = Math.min(10, Math.max(7, label.length + 1));
  const valueWidth = Math.max(1, safeWidth - labelWidth);
  const value = theme.fg(valueColor, inline(rawValue));
  const wrapped = wrapTextWithAnsi(value, valueWidth);
  const prefix = theme.fg('muted', label.padEnd(labelWidth));
  return (wrapped.length > 0 ? wrapped : ['']).map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${' '.repeat(labelWidth)}${line}`,
  );
}

function boxed(
  theme: Theme,
  title: string,
  width: number,
  content: string[],
  color: ThemeColor = 'borderMuted',
): string[] {
  const safeWidth = Math.max(8, Math.floor(width));
  const bodyWidth = Math.max(1, safeWidth - 4);
  const topLabel = `╭─ ${title} `;
  const top = `${topLabel}${'─'.repeat(
    Math.max(0, safeWidth - visibleWidth(topLabel) - 1),
  )}╮`;
  const bottom = `╰${'─'.repeat(Math.max(0, safeWidth - 2))}╯`;
  const body = content.length > 0 ? content : [''];
  return [
    theme.fg(color, top),
    ...body.map(
      (line) =>
        `${theme.fg(color, '│')} ${padAnsi(
          truncateToWidth(line, bodyWidth),
          bodyWidth,
        )} ${theme.fg(color, '│')}`,
    ),
    theme.fg(color, bottom),
  ];
}

function joinPanels(
  left: string[],
  leftWidth: number,
  right: string[],
  rightWidth: number,
  gap: number,
): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = padAnsi(left[index] ?? '', leftWidth);
    const rightLine = padAnsi(right[index] ?? '', rightWidth);
    return `${leftLine}${' '.repeat(gap)}${rightLine}`;
  });
}

function joinColumns(
  left: string,
  right: string,
  width: number,
  leftWidth: number,
): string {
  const safeLeftWidth = Math.max(1, Math.min(leftWidth, width - 2));
  const rightWidth = Math.max(1, width - safeLeftWidth - 1);
  return `${padAnsi(
    truncateToWidth(left, safeLeftWidth),
    safeLeftWidth,
  )} ${truncateToWidth(right, rightWidth)}`;
}

function padAnsi(value: string, width: number): string {
  const visible = visibleWidth(value);
  if (visible >= width) return value;
  return `${value}${' '.repeat(width - visible)}`;
}

function statusGlyph(theme: Theme, status: StepDisplayStatus): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'running') return theme.fg('accent', '↻');
  if (status === 'paused' || status === 'awaiting-gate') {
    return theme.fg('warning', '◆');
  }
  if (status === 'aborted') return theme.fg('error', '✕');
  return theme.fg('dim', '•');
}

function statusColor(status: StepDisplayStatus): ThemeColor {
  if (status === 'completed') return 'success';
  if (status === 'running') return 'accent';
  if (status === 'paused' || status === 'awaiting-gate') return 'warning';
  if (status === 'aborted') return 'error';
  return 'dim';
}

function statusLabel(status: StepDisplayStatus): string {
  return status === 'awaiting-gate'
    ? 'AWAITING REVIEW'
    : status.toUpperCase().replaceAll('-', ' ');
}

function statusBadge(theme: Theme, status: StepDisplayStatus): string {
  return theme.fg(statusColor(status), theme.bold(`[${statusLabel(status)}]`));
}

function stepTitle(
  workflow: LoadedWorkflow | undefined,
  stepId: string,
): string {
  return inline(workflow?.definition.steps[stepId]?.title ?? stepId);
}

function formatStepName(title: string, stepId: string): string {
  const safeStepId = inline(stepId);
  return title === safeStepId ? title : `${title} (${safeStepId})`;
}

function formatExecution(
  execution: WorkflowStatusExecution | undefined,
): string | undefined {
  if (!execution) return undefined;
  if (execution.kind === 'main') return 'main agent';
  return `${execution.agent} · ${execution.progress} · ${execution.requestId}`;
}

function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function elapsedMs(snapshot: WorkflowStatusSnapshot): number {
  const { run } = snapshot;
  const end =
    run.status === 'running' || run.status === 'awaiting-gate'
      ? snapshot.now
      : run.updatedAt;
  return Math.max(0, end - run.startedAt);
}

function formatElapsed(milliseconds: number): string {
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

function formatTimestamp(milliseconds: number): string {
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
