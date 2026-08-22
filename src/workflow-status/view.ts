import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type KeyId,
} from '@earendil-works/pi-tui';
import { DEFAULT_STATUS_SHORTCUT } from '../config/types.ts';
import {
  formatShortcutLabel,
  runDisplayStatus,
  statusGlyph,
  statusLabel,
} from './formatting.ts';
import { padAnsi } from './layout.ts';
import { renderBoard, renderEmptyBoard } from './render-board.ts';
import { buildPathEntries } from './render-path.ts';
import {
  renderLiveWorkerActivity,
  renderStepDetail,
  selectedStepDetail,
  stepTranscriptCacheKey,
  type StepTranscriptViewState,
} from './render-step-detail.ts';
import { readStepTranscript } from './transcript-reader.ts';
import type {
  SnapshotProvider,
  StepTranscriptLoader,
  StatusViewTui,
  WorkflowStatusTheme,
} from './types.ts';

const REFRESH_INTERVAL_MS = 250;

type RefreshTimer = ReturnType<typeof setInterval>;

export type WorkflowStatusViewDependencies = {
  readonly scheduleRefresh: (
    render: () => void,
    intervalMilliseconds: number,
  ) => RefreshTimer;
  readonly cancelRefresh: (timer: RefreshTimer) => void;
  readonly loadStepTranscript: StepTranscriptLoader;
};

type ViewportState = {
  readonly isClosed: boolean;
  readonly mode: 'board' | 'detail' | 'live';
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly viewportRows: number;
  readonly contentRows: number;
};

type PaginatedBoard = {
  readonly state: ViewportState;
  readonly lines: Array<string>;
};

const DEFAULT_VIEW_DEPENDENCIES = {
  scheduleRefresh: (render, intervalMilliseconds) =>
    setInterval(render, intervalMilliseconds),
  cancelRefresh: (timer) => {
    clearInterval(timer);
  },
  loadStepTranscript: async (attempt) =>
    attempt.transcript
      ? readStepTranscript(attempt.transcript)
      : {
          status: 'unavailable',
          reason: 'No trusted child transcript reference was recorded.',
        },
} as const satisfies WorkflowStatusViewDependencies;

function initialViewportState(): ViewportState {
  return {
    isClosed: false,
    mode: 'board',
    selectedIndex: -1,
    scrollOffset: 0,
    viewportRows: 0,
    contentRows: 0,
  };
}

function paginateBoard(
  state: ViewportState,
  lines: ReadonlyArray<string>,
  width: number,
  terminalRows: number | undefined,
  statusShortcutLabel: string,
  theme: WorkflowStatusTheme,
  controls: string,
): PaginatedBoard {
  const maximumRows =
    terminalRows === undefined
      ? lines.length + 1
      : Math.max(4, Math.floor(terminalRows * 0.95));
  const contentHeight = Math.max(1, maximumRows - 1);
  const maximumOffset = Math.max(0, lines.length - contentHeight);
  const scrollOffset = Math.min(state.scrollOffset, maximumOffset);
  const visible = lines.slice(scrollOffset, scrollOffset + contentHeight);
  const first = lines.length === 0 ? 0 : scrollOffset + 1;
  const last = Math.min(lines.length, scrollOffset + contentHeight);
  const hint =
    maximumOffset > 0
      ? `${controls} · rows ${first}-${last}/${lines.length} · ${statusShortcutLabel} / q hide`
      : `${controls} · ${statusShortcutLabel} / q hide · live refresh`;
  return {
    state: {
      ...state,
      scrollOffset,
      viewportRows: maximumRows,
      contentRows: lines.length,
    },
    lines: [
      ...visible,
      padAnsi(truncateToWidth(theme.fg('dim', hint), width, '…'), width),
    ],
  };
}

function nextScrollOffset(state: ViewportState, value: number): number {
  const contentHeight = Math.max(1, state.viewportRows - 1);
  const maximumOffset = Math.max(0, state.contentRows - contentHeight);
  return Math.max(0, Math.min(value, maximumOffset));
}

/**
 * Stateful TUI adapter around the pure workflow-status rendering functions.
 *
 * Timer effects are supplied explicitly so tests and alternative hosts can
 * replace the Node.js scheduling boundary.
 */
export class WorkflowStatusView implements Component {
  private timer: RefreshTimer | undefined;
  private state = initialViewportState();
  private pendingDetailTopKey = false;
  private readonly statusShortcutLabel: string;
  private readonly dependencies: WorkflowStatusViewDependencies;
  private readonly transcriptCache = new Map<string, StepTranscriptViewState>();

  /**
   * Creates the stateful adapter around the pure status renderer.
   *
   * @param getSnapshot - Supplies the latest workflow status value.
   * @param tui - TUI render-invalidation boundary.
   * @param theme - Theme used to render the board.
   * @param done - Callback invoked when the view closes.
   * @param statusShortcut - Shortcut displayed in the view.
   * @param dependencies - Injectable refresh scheduling effects.
   */
  constructor(
    private readonly getSnapshot: SnapshotProvider,
    private readonly tui: StatusViewTui,
    private readonly theme: WorkflowStatusTheme,
    private readonly done: () => void,
    private readonly statusShortcut: KeyId = DEFAULT_STATUS_SHORTCUT,
    dependencies: Partial<WorkflowStatusViewDependencies> = {},
  ) {
    this.statusShortcutLabel = formatShortcutLabel(statusShortcut);
    this.dependencies = { ...DEFAULT_VIEW_DEPENDENCIES, ...dependencies };
  }

  /** Start periodic live-refresh requests. */
  start(): void {
    this.timer = this.dependencies.scheduleRefresh(() => {
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stop periodic live-refresh requests. */
  dispose(): void {
    if (this.timer) this.dependencies.cancelRefresh(this.timer);
    this.timer = undefined;
  }

  /** Satisfy the TUI component invalidation contract. */
  invalidate(): void {}

  /** Handle close and scrolling key input. */
  handleInput(data: string): void {
    if (
      data === 'q' ||
      data === 'Q' ||
      matchesKey(data, 'ctrl+c') ||
      (this.state.mode === 'board' && matchesKey(data, 'ctrl+d')) ||
      matchesKey(data, this.statusShortcut)
    ) {
      this.close();
      return;
    }
    if (matchesKey(data, 'escape')) {
      if (this.state.mode === 'live') {
        this.showDetail();
      } else if (this.state.mode === 'detail') {
        this.showBoard();
      } else {
        this.close();
      }
      return;
    }
    const pageSize = Math.max(1, this.state.viewportRows - 2);
    const contentHeight = Math.max(1, this.state.viewportRows - 1);
    const halfPageSize = Math.max(1, Math.floor(contentHeight / 2));
    if (this.state.mode === 'detail' || this.state.mode === 'live') {
      if (matchesKey(data, Key.tab)) {
        if (this.state.mode === 'detail') this.showLive();
        else this.showDetail();
        return;
      }
      if (data === 'gg' || (data === 'g' && this.pendingDetailTopKey)) {
        this.pendingDetailTopKey = false;
        this.setScrollOffset(0);
        return;
      }
      if (data === 'g') {
        this.pendingDetailTopKey = true;
        return;
      }
      this.pendingDetailTopKey = false;
      if (data === 'G') {
        this.setScrollOffset(Number.MAX_SAFE_INTEGER);
      } else if (matchesKey(data, Key.left) || data === 'h') {
        if (this.state.mode === 'live') this.showDetail();
        else this.showBoard();
      } else if (matchesKey(data, Key.down) || data === 'j') {
        this.setScrollOffset(this.state.scrollOffset + 1);
      } else if (matchesKey(data, Key.up) || data === 'k') {
        this.setScrollOffset(this.state.scrollOffset - 1);
      } else if (matchesKey(data, Key.ctrl('d'))) {
        this.setScrollOffset(this.state.scrollOffset + halfPageSize);
      } else if (matchesKey(data, Key.ctrl('u'))) {
        this.setScrollOffset(this.state.scrollOffset - halfPageSize);
      } else if (matchesKey(data, Key.pageDown)) {
        this.setScrollOffset(this.state.scrollOffset + pageSize);
      } else if (matchesKey(data, Key.pageUp)) {
        this.setScrollOffset(this.state.scrollOffset - pageSize);
      } else if (matchesKey(data, Key.home)) {
        this.setScrollOffset(0);
      } else if (matchesKey(data, Key.end)) {
        this.setScrollOffset(Number.MAX_SAFE_INTEGER);
      }
      return;
    }
    this.pendingDetailTopKey = false;
    if (matchesKey(data, Key.down) || data === 'j') {
      this.moveSelection(1);
    } else if (matchesKey(data, Key.up) || data === 'k') {
      this.moveSelection(-1);
    } else if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.right) ||
      data === 'l'
    ) {
      this.openDetail();
    } else if (matchesKey(data, Key.pageDown)) {
      this.setScrollOffset(this.state.scrollOffset + pageSize);
    } else if (matchesKey(data, Key.pageUp)) {
      this.setScrollOffset(this.state.scrollOffset - pageSize);
    } else if (matchesKey(data, Key.home)) {
      this.setScrollOffset(0);
    } else if (matchesKey(data, Key.end)) {
      this.setScrollOffset(Number.MAX_SAFE_INTEGER);
    }
  }

  /** Render the current snapshot at the requested terminal width. */
  render(width: number): Array<string> {
    const viewportWidth = Math.max(1, Math.floor(width || 1));
    const snapshot = this.getSnapshot();
    if (viewportWidth < 12) {
      const label = snapshot
        ? `${statusGlyph(
            this.theme,
            runDisplayStatus(snapshot.run),
            snapshot.now,
          )} ${snapshot.run.workflowId} ${statusLabel(snapshot.run.status)}`
        : 'No workflow';
      return [truncateToWidth(label, viewportWidth, '…', true)];
    }

    const contentWidth = viewportWidth - 2;
    if (snapshot) this.normalizeSelection(snapshot);
    const lines = snapshot
      ? this.state.mode === 'detail'
        ? renderStepDetail(
            this.theme,
            snapshot,
            this.state.selectedIndex,
            this.transcriptCache,
            contentWidth,
          )
        : this.state.mode === 'live'
          ? renderLiveWorkerActivity(
              this.theme,
              snapshot,
              this.state.selectedIndex,
              contentWidth,
            )
          : renderBoard(
              this.theme,
              snapshot,
              contentWidth,
              false,
              this.statusShortcutLabel,
              this.state.selectedIndex,
            )
      : renderEmptyBoard(this.theme, contentWidth);
    if (snapshot && this.state.mode === 'detail') {
      this.ensureSelectedTranscripts(snapshot);
    }
    const rendered = lines.map((line) =>
      padAnsi(truncateToWidth(line, contentWidth, '…'), viewportWidth),
    );
    const page = paginateBoard(
      this.state,
      rendered,
      viewportWidth,
      this.tui.terminal?.rows,
      this.statusShortcutLabel,
      this.theme,
      this.state.mode === 'detail'
        ? '↑↓/jk · Ctrl+D/U half-page · gg/G top/bottom · PgUp/PgDn · Tab live · ←/h/Esc'
        : this.state.mode === 'live'
          ? '↑↓/jk · Ctrl+D/U half-page · gg/G top/bottom · PgUp/PgDn · Tab/←/h/Esc overview'
          : '↑/↓ or j/k select · Enter/→/l inspect · PgUp/PgDn',
    );
    this.state = page.state;
    return page.lines;
  }

  private setScrollOffset(value: number): void {
    const scrollOffset = nextScrollOffset(this.state, value);
    if (scrollOffset === this.state.scrollOffset) return;
    this.state = { ...this.state, scrollOffset };
    this.tui.requestRender(true);
  }

  private normalizeSelection(
    snapshot: NonNullable<ReturnType<SnapshotProvider>>,
  ): void {
    const entries = buildPathEntries(snapshot);
    const selectedIndex =
      entries.length === 0
        ? -1
        : this.state.selectedIndex < 0
          ? entries.length - 1
          : Math.min(this.state.selectedIndex, entries.length - 1);
    if (selectedIndex !== this.state.selectedIndex) {
      this.state = { ...this.state, selectedIndex };
    }
    if (entries.length === 0 && this.state.mode === 'detail') {
      this.state = { ...this.state, mode: 'board', scrollOffset: 0 };
    }
  }

  private moveSelection(delta: number): void {
    const snapshot = this.getSnapshot();
    if (!snapshot) return;
    this.normalizeSelection(snapshot);
    const entries = buildPathEntries(snapshot);
    if (entries.length === 0) return;
    const selectedIndex = Math.max(
      0,
      Math.min(this.state.selectedIndex + delta, entries.length - 1),
    );
    if (selectedIndex === this.state.selectedIndex) return;
    this.state = { ...this.state, selectedIndex };
    this.tui.requestRender(true);
  }

  private openDetail(): void {
    const snapshot = this.getSnapshot();
    if (!snapshot) return;
    this.normalizeSelection(snapshot);
    if (!selectedStepDetail(snapshot, this.state.selectedIndex)) return;
    this.pendingDetailTopKey = false;
    this.state = { ...this.state, mode: 'detail', scrollOffset: 0 };
    this.ensureSelectedTranscripts(snapshot);
    this.tui.requestRender(true);
  }

  private showBoard(): void {
    if (this.state.mode === 'board') return;
    this.pendingDetailTopKey = false;
    this.state = { ...this.state, mode: 'board', scrollOffset: 0 };
    this.tui.requestRender(true);
  }

  private showDetail(): void {
    if (this.state.mode === 'detail') return;
    this.pendingDetailTopKey = false;
    this.state = { ...this.state, mode: 'detail', scrollOffset: 0 };
    this.tui.requestRender(true);
  }

  private showLive(): void {
    const snapshot = this.getSnapshot();
    if (!snapshot) return;
    const entry = buildPathEntries(snapshot)[this.state.selectedIndex];
    if (!entry?.isCurrent || snapshot.execution?.kind !== 'subagent') return;
    this.pendingDetailTopKey = false;
    this.state = { ...this.state, mode: 'live', scrollOffset: 0 };
    this.tui.requestRender(true);
  }

  private ensureSelectedTranscripts(
    snapshot: NonNullable<ReturnType<SnapshotProvider>>,
  ): void {
    const detail = selectedStepDetail(snapshot, this.state.selectedIndex);
    if (!detail) return;
    for (const attempt of detail.attempts) {
      if (attempt.kind !== 'subagent' || !attempt.transcript) continue;
      const key = stepTranscriptCacheKey(snapshot.run.runId, attempt);
      if (this.transcriptCache.has(key)) continue;
      this.transcriptCache.set(key, { status: 'loading' });
      void this.dependencies.loadStepTranscript(attempt).then(
        (result) => {
          this.transcriptCache.set(key, result);
          if (!this.state.isClosed) this.tui.requestRender(true);
        },
        () => {
          this.transcriptCache.set(key, {
            status: 'unavailable',
            reason: 'The child transcript could not be loaded safely.',
          });
          if (!this.state.isClosed) this.tui.requestRender(true);
        },
      );
    }
  }

  private close(): void {
    if (this.state.isClosed) return;
    this.state = { ...this.state, isClosed: true };
    this.dispose();
    this.done();
    this.tui.requestRender(true);
  }
}

/** Open the live workflow status overlay using an injected snapshot provider. */
export async function showWorkflowStatus(
  ctx: ExtensionContext,
  getSnapshot: SnapshotProvider,
  statusShortcut: KeyId = DEFAULT_STATUS_SHORTCUT,
  dependencies: Partial<WorkflowStatusViewDependencies> = {},
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      const view = new WorkflowStatusView(
        getSnapshot,
        tui,
        theme,
        () => {
          done(undefined);
        },
        statusShortcut,
        dependencies,
      );
      view.start();
      return view;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: 'center',
        width: '95%',
        maxHeight: '95%',
        margin: 1,
      },
    },
  );
}
