import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import type {
  LoadedWorkflow,
  WorkflowCatalog,
  WorkflowStep,
} from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import type { PromptGateReviewResult } from '../integrations/prompt-gate.ts';
import type { SubagentDelegationClientController } from '../integrations/subagents/client.ts';
import type {
  SubagentDelegationResponse,
  SubagentDelegationUpdate,
} from '../integrations/subagents/protocol.ts';
import type { MainStepRuntimeController } from '../runtime/main-step-runtime.ts';
import type { SerialTaskQueueController } from '../runtime/serial-task-queue.ts';
import type { WorkflowStepResult } from '../runtime/step-result.ts';
import type { WorkflowStatusSnapshot } from '../workflow-status.ts';
import type { DelegationFailureActions } from './delegation-failure.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';
import type { SettledStepReport } from './step-reporting.ts';
import type {
  ActiveDelegation,
  ActivePromptReview,
  DelegationRecovery,
  DelegationFailureDetails,
  MainStepIdentity,
  WorkflowStartContext,
} from './types.ts';

/**
 * Internal composition surface shared by the harness action modules.
 *
 * The class facade owns this state. Action modules receive it as their dynamic
 * `this` value so their dependencies stay explicit and independently testable.
 */
export type HarnessActionContext = {
  pi: ExtensionAPI;
  dependencies: WorkflowHarnessDependencies;
  delegationFailures: DelegationFailureActions;
  subagents: SubagentDelegationClientController;
  mainSteps: MainStepRuntimeController;
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
  mutationQueue: SerialTaskQueueController;
  statusShortcut: KeyId;
  statusShortcutLabel: string;
  statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  isStatusOverlayOpen: boolean;
  legacyProgressWidgetContext: ExtensionContext | undefined;
  workflowIds: () => Array<string>;
  list: (context: ExtensionCommandContext) => Promise<void>;
  doctor: (
    workflowId: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  start: (
    workflowId: string,
    input: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  startNow: (
    workflowId: string,
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ) => Promise<void>;
  pause: (reason: string, context: ExtensionCommandContext) => Promise<void>;
  pauseNow: (reason: string, context: ExtensionCommandContext) => Promise<void>;
  resume: (input: string, context: ExtensionCommandContext) => Promise<void>;
  resumeNow: (
    context: ExtensionCommandContext,
    input?: string,
  ) => Promise<void>;
  abort: (reason: string, context: ExtensionCommandContext) => Promise<void>;
  abortNow: (reason: string, context: ExtensionCommandContext) => Promise<void>;
  reload: (context: ExtensionCommandContext) => Promise<void>;
  reloadNow: (context: ExtensionCommandContext) => Promise<void>;
  workflowStatusSnapshot: () => WorkflowStatusSnapshot | undefined;
  registerLifecycle: () => void;
  registerPolicy: () => void;
  registerMultilineCommandInput: () => void;
  launchCurrentStep: (
    workflow: LoadedWorkflow,
    recovery?: DelegationRecovery,
  ) => void;
  launchMainStep: (
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    step: WorkflowStep,
  ) => void;
  queueMainStepLog: (
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
  ) => Promise<void>;
  recordMainStepLog: (
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
  ) => Promise<void>;
  queueMainStepResult: (
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void>;
  finishMainStep: (
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void>;
  handleDelegationUpdate: (
    active: ActiveDelegation,
    update: SubagentDelegationUpdate,
  ) => void;
  queueDelegationResponse: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => void;
  queueDelegationFailure: (active: ActiveDelegation, reason: string) => void;
  finishDelegation: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => Promise<void>;
  cancelActiveDelegation: (reason: string) => Promise<boolean>;
  cleanupDelegation: (active: ActiveDelegation) => Promise<void>;
  retryDelegationAfterFailure: (
    active: ActiveDelegation,
    failure: DelegationFailureDetails | undefined,
    reason: string,
  ) => boolean;
  pauseForDelegationFailure: (reason: string, failureSummary?: string) => void;
  pauseForExecutionFailure: (
    label: string,
    reason: string,
    failureSummary?: string,
  ) => void;
  retainUnconfirmedDelegation: (
    active: ActiveDelegation,
    reason: string,
  ) => void;
  releaseMainAfterCancellation: (active: ActiveDelegation) => void;
  submitGate: (
    workflow: LoadedWorkflow,
    originalRun: WorkflowRun,
    outcome: string,
    summary: string,
    artifact: string,
  ) => Promise<void>;
  launchPromptReview: (
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    context: ExtensionContext | undefined,
  ) => void;
  queuePromptReviewResult: (
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => void;
  queuePromptReviewFailure: (
    active: ActivePromptReview,
    reason: string,
  ) => void;
  finishPromptReview: (
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => Promise<void>;
  pausePromptGate: (requestId: string, reason: string, failed: boolean) => void;
  cancelPromptReview: () => void;
  registerPlannotatorResults: () => void;
  handlePlannotatorResult: (data: unknown) => Promise<void>;
  settleAfterTransition: (
    workflow: LoadedWorkflow,
    report: SettledStepReport,
  ) => void;
  preflight: (workflow: LoadedWorkflow, stepId: string) => Array<string>;
  isolateMainSessionTools: () => void;
  restoreBaselineTools: () => void;
  captureSkills: (skills: ReadonlyArray<{ name: string }> | undefined) => void;
  enqueueMutation: (
    context: ExtensionContext,
    operation: (sessionEpoch: number) => Promise<void>,
  ) => Promise<void>;
  persist: () => void;
  restoreFromSession: (context: ExtensionContext) => void;
  reloadCatalog: (
    context: ExtensionContext,
    announce: boolean,
  ) => Promise<boolean>;
  updateStatus: () => void;
  refreshStatusWhileRunning: () => void;
  stopStatusRefresh: () => void;
  registerWorkflowStatusShortcut: () => void;
  showWorkflowStatus: (context: ExtensionContext) => Promise<void>;
};
