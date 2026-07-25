import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun, WorkflowRunStatus } from '../engine/state.ts';

export type WorkflowStatusExecution =
  | {
      readonly kind: 'main';
    }
  | {
      readonly kind: 'subagent';
      readonly agent: string;
      readonly requestId: string;
      readonly progress: string;
    };

export type WorkflowStatusSnapshot = {
  readonly run: WorkflowRun;
  readonly workflow?: LoadedWorkflow;
  readonly execution?: WorkflowStatusExecution;
  readonly now: number;
};

export type SnapshotProvider = () => WorkflowStatusSnapshot | undefined;
export type StepDisplayStatus = WorkflowRunStatus | 'failed';
export type StatusViewTui = Pick<TUI, 'requestRender'> & {
  readonly terminal?: { readonly rows: number };
};

export type PathEntry = {
  readonly stepId: string;
  readonly title: string;
  readonly status: StepDisplayStatus;
  readonly visit: number;
  readonly outcome?: string;
  readonly isCurrent: boolean;
};

export type WorkflowStatusThemeColor = ThemeColor;
export type WorkflowStatusTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;
