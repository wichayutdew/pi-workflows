import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import type { WorkflowCatalog } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import type { MainStepRuntimeController } from '../runtime/main-step-runtime.ts';
import {
  formatWorkflowProgressStatus,
  type WorkflowStatusExecution,
  type WorkflowStatusSnapshot,
} from '../workflow-status.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';
import type { ActiveDelegation } from './types.ts';

const STATUS_KEY = 'pi-workflows';
const LEGACY_PROGRESS_WIDGET_KEY = 'pi-workflows-progress';
const STATUS_REFRESH_INTERVAL_MS = 250;

type StatusContext = {
  pi: ExtensionAPI;
  dependencies: WorkflowHarnessDependencies;
  catalog: WorkflowCatalog;
  run: WorkflowRun | undefined;
  latestContext: ExtensionContext | undefined;
  activeDelegation: ActiveDelegation | undefined;
  mainSteps: MainStepRuntimeController;
  statusShortcut: KeyId;
  statusShortcutLabel: string;
  statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  isStatusOverlayOpen: boolean;
  legacyProgressWidgetContext: ExtensionContext | undefined;
  workflowStatusSnapshot: () => WorkflowStatusSnapshot | undefined;
  updateStatus: () => void;
  stopStatusRefresh: () => void;
  showWorkflowStatus: (context: ExtensionContext) => Promise<void>;
};

export type StatusActions = {
  workflowStatusSnapshot: (
    this: StatusContext,
  ) => WorkflowStatusSnapshot | undefined;
  updateStatus: (this: StatusContext) => void;
  refreshStatusWhileRunning: (this: StatusContext) => void;
  stopStatusRefresh: (this: StatusContext) => void;
  registerWorkflowStatusShortcut: (this: StatusContext) => void;
  showWorkflowStatus: (
    this: StatusContext,
    context: ExtensionContext,
  ) => Promise<void>;
};

function workflowStatusSnapshot(
  this: StatusContext,
): WorkflowStatusSnapshot | undefined {
  if (!this.run) return undefined;
  const workflow = this.catalog.workflows.get(this.run.workflowId);
  let execution: WorkflowStatusExecution | undefined;
  if (this.activeDelegation) {
    execution = {
      kind: 'subagent',
      agent: this.activeDelegation.agent,
      requestId: this.activeDelegation.requestId,
      progress: this.activeDelegation.progress ?? 'starting',
      activityLog: this.activeDelegation.activityLog ?? [],
      ...(this.activeDelegation.model
        ? { model: this.activeDelegation.model }
        : {}),
    };
  } else if (this.mainSteps.activeStepId) {
    execution = { kind: 'main' };
  }
  return {
    run: this.run,
    now: this.dependencies.now(),
    ...(workflow ? { workflow } : {}),
    ...(execution ? { execution } : {}),
  };
}

function updateStatus(this: StatusContext): void {
  refreshStatusWhileRunning.call(this);
  const run = this.run;
  this.pi.events.emit('pi-workflows:state', {
    state:
      run?.status === 'running'
        ? 'working'
        : run?.status === 'awaiting-gate' || run?.status === 'paused'
          ? 'blocked'
          : run?.status === 'completed'
            ? 'completed'
            : 'interrupted',
    workflowId: run?.workflowId,
    stepId: run?.currentStepId,
    message:
      run?.status === 'completed'
        ? `Workflow "${run.workflowId}" completed`
        : run?.status === 'paused'
          ? run.pauseReason
          : undefined,
  });
  if (!this.latestContext) return;
  if (this.legacyProgressWidgetContext !== this.latestContext) {
    this.latestContext.ui.setWidget(LEGACY_PROGRESS_WIDGET_KEY, undefined);
    this.legacyProgressWidgetContext = this.latestContext;
  }
  if (!this.run) {
    this.latestContext.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const snapshot = this.workflowStatusSnapshot();
  if (this.run.status !== 'running' && this.run.status !== 'awaiting-gate') {
    this.latestContext.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  if (!snapshot) {
    this.latestContext.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  this.latestContext.ui.setStatus(
    STATUS_KEY,
    formatWorkflowProgressStatus(snapshot, this.statusShortcutLabel),
  );
}

function refreshStatusWhileRunning(this: StatusContext): void {
  if (this.run?.status === 'running' && this.latestContext) {
    if (this.statusRefreshTimer) return;
    this.statusRefreshTimer = this.dependencies.scheduleInterval(() => {
      this.updateStatus();
    }, STATUS_REFRESH_INTERVAL_MS);
    this.statusRefreshTimer.unref();
    return;
  }
  this.stopStatusRefresh();
}

function stopStatusRefresh(this: StatusContext): void {
  if (this.statusRefreshTimer) {
    this.dependencies.cancelInterval(this.statusRefreshTimer);
  }
  this.statusRefreshTimer = undefined;
}

function registerWorkflowStatusShortcut(this: StatusContext): void {
  this.pi.registerShortcut(this.statusShortcut, {
    description: 'Toggle workflow status',
    handler: async (extensionContext) => {
      this.latestContext = extensionContext;
      if (this.isStatusOverlayOpen) return;
      if (!this.run) {
        extensionContext.ui.notify(
          'No workflow checkpoint in this session',
          'info',
        );
        return;
      }
      await this.showWorkflowStatus(extensionContext);
    },
  });
}

async function showWorkflowStatus(
  this: StatusContext,
  context: ExtensionContext,
): Promise<void> {
  if (
    this.isStatusOverlayOpen ||
    !this.run ||
    !context.hasUI ||
    context.mode !== 'tui'
  ) {
    return;
  }
  this.isStatusOverlayOpen = true;
  try {
    await this.dependencies.showWorkflowStatus(
      context,
      () => this.workflowStatusSnapshot(),
      this.statusShortcut,
      {
        scheduleRefresh: this.dependencies.scheduleInterval,
        cancelRefresh: this.dependencies.cancelInterval,
      },
    );
  } finally {
    this.isStatusOverlayOpen = false;
  }
}

/**
 * Returns the status-related workflow actions for composition by the harness.
 */
export function createStatusActions(): StatusActions {
  return {
    workflowStatusSnapshot,
    updateStatus,
    refreshStatusWhileRunning,
    stopStatusRefresh,
    registerWorkflowStatusShortcut,
    showWorkflowStatus,
  };
}
