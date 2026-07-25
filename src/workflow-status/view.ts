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
import type {
  SnapshotProvider,
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
};

type ViewportState = {
  readonly isClosed: boolean;
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
} as const satisfies WorkflowStatusViewDependencies;

function initialViewportState(): ViewportState {
  return {
    isClosed: false,
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
      ? `↑/↓ PgUp/PgDn Home/End · rows ${first}-${last}/${lines.length} · ${statusShortcutLabel} / q / Esc hide`
      : `${statusShortcutLabel} / q / Esc hide · live refresh`;
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
  private readonly statusShortcutLabel: string;

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
    private readonly dependencies: WorkflowStatusViewDependencies = DEFAULT_VIEW_DEPENDENCIES,
  ) {
    this.statusShortcutLabel = formatShortcutLabel(statusShortcut);
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
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      matchesKey(data, 'ctrl+d') ||
      matchesKey(data, this.statusShortcut)
    ) {
      this.close();
      return;
    }
    const pageSize = Math.max(1, this.state.viewportRows - 2);
    if (matchesKey(data, Key.down) || data === 'j') {
      this.setScrollOffset(this.state.scrollOffset + 1);
    } else if (matchesKey(data, Key.up) || data === 'k') {
      this.setScrollOffset(this.state.scrollOffset - 1);
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
    const lines = snapshot
      ? renderBoard(
          this.theme,
          snapshot,
          contentWidth,
          false,
          this.statusShortcutLabel,
        )
      : renderEmptyBoard(this.theme, contentWidth);
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
  dependencies: WorkflowStatusViewDependencies = DEFAULT_VIEW_DEPENDENCIES,
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
