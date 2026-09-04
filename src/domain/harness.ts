import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import type { WorkflowCatalog } from './config.ts';
import type { WorkflowRun } from './state.ts';
import type { ChildStepPolicy } from './subagent.ts';

/**
 * Slash commands owned by the workflow harness.
 */
export const HARNESS_COMMAND_NAMES = [
  'workflow-abort',
  'workflow-doctor',
  'workflow-list',
  'workflow-pause',
  'workflow-reload',
  'workflow-restart',
  'workflow-resume',
  'workflow-start',
] as const;

/**
 * Interactive commands handled by Pi before extension command dispatch.
 * Hidden diagnostic commands are included because an alias cannot reach them.
 */
export const PI_BUILTIN_COMMAND_NAMES = [
  'arminsayshi',
  'changelog',
  'clone',
  'compact',
  'copy',
  'debug',
  'dementedelves',
  'export',
  'fork',
  'hotkeys',
  'import',
  'login',
  'logout',
  'model',
  'name',
  'new',
  'quit',
  'reload',
  'resume',
  'scoped-models',
  'session',
  'settings',
  'share',
  'tree',
  'trust',
] as const;

/**
 * Command names that workflow aliases may not shadow.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...HARNESS_COMMAND_NAMES,
  ...PI_BUILTIN_COMMAND_NAMES,
]);

export type ActiveDelegation = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
  resultDirectory: string;
  policy: ChildStepPolicy;
  transcriptTask: string;
  agent: string;
  model?: string;
  progress?: string;
  activityLog?: Array<string>;
  cancelling?: boolean;
};

export type MainStepIdentity = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
};

export type ActivePromptReview = {
  requestId: string;
  runId: string;
  stepId: string;
  sessionEpoch: number;
  abortController: AbortController;
};

export type WorkflowStartContext = {
  context: ExtensionContext;
  skills: () => ReadonlyArray<{ name: string }> | undefined;
  waitForIdle: () => Promise<void>;
};

export type HarnessState = {
  catalog: WorkflowCatalog;
  run: WorkflowRun | undefined;
  latestContext: ExtensionContext | undefined;
  availableSkills: Set<string>;
  isSessionActive: boolean;
  sessionEpoch: number;
  activeDelegation: ActiveDelegation | undefined;
  activePromptReview: ActivePromptReview | undefined;
  registeredWorkflowCommands: Set<string>;
  catalogLoadSequence: number;
  statusShortcut: KeyId;
  statusShortcutLabel: string;
  statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  isStatusOverlayOpen: boolean;
  legacyProgressWidgetContext: ExtensionContext | undefined;
};
