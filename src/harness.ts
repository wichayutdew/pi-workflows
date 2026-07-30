import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import {
  registerHarnessCommands,
  type WorkflowCommandController,
} from './commands.ts';
import {
  DEFAULT_STATUS_SHORTCUT,
  type LoadedWorkflow,
  type WorkflowCatalog,
  type WorkflowStep,
} from './config/types.ts';
import type { WorkflowRun } from './engine/state.ts';
import { type PromptGateReviewResult } from './integrations/prompt-gate.ts';
import type { SubagentDelegationClientController } from './integrations/subagents/client.ts';
import {
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from './integrations/subagents/protocol.ts';
import type { MainStepRuntimeController } from './runtime/main-step-runtime.ts';
import type { SerialTaskQueueController } from './runtime/serial-task-queue.ts';
import type { WorkflowStepResult } from './runtime/step-result.ts';
import {
  createDelegationFailureActions,
  type DelegationFailureActions,
} from './harness/delegation-failure.ts';
import { createEmptyCatalog } from './harness/catalog.ts';
import {
  createWorkflowHarnessDependencies,
  type WorkflowHarnessDependencies,
} from './harness/dependencies.ts';
import type {
  ActiveDelegation,
  ActivePromptReview,
  DelegationRecovery,
  DelegationFailureDetails,
  MainStepIdentity,
  WorkflowStartContext,
} from './harness/types.ts';
import { createStatusActions } from './harness/status-actions.ts';
import { createStartActions } from './harness/start-actions.ts';
import { createPauseActions } from './harness/pause-actions.ts';
import { createResumeAction } from './harness/resume-action.ts';
import { createLifecycleActions } from './harness/lifecycle-actions.ts';
import { createStepExecutionActions } from './harness/step-execution-actions.ts';
import { createDelegationResponseActions } from './harness/delegation-response-actions.ts';
import { createDelegationControlActions } from './harness/delegation-control-actions.ts';
import { createGateSubmissionAction } from './harness/gate-submission-action.ts';
import { createPromptGateActions } from './harness/prompt-gate-actions.ts';
import { createPlannotatorResultActions } from './harness/plannotator-result-actions.ts';
import { createCoreActions } from './harness/core-actions.ts';
import type { SettledStepReport } from './harness/step-reporting.ts';
import {
  formatShortcutLabel,
  type WorkflowStatusSnapshot,
} from './workflow-status.ts';

const STATUS_ACTIONS = createStatusActions();
const START_ACTIONS = createStartActions();
const PAUSE_ACTIONS = createPauseActions();
const RESUME_ACTION = createResumeAction();
const LIFECYCLE_ACTIONS = createLifecycleActions();
const STEP_EXECUTION_ACTIONS = createStepExecutionActions();
const DELEGATION_RESPONSE_ACTIONS = createDelegationResponseActions();
const DELEGATION_CONTROL_ACTIONS = createDelegationControlActions();
const GATE_SUBMISSION_ACTION = createGateSubmissionAction();
const PROMPT_GATE_ACTIONS = createPromptGateActions();
const PLANNOTATOR_RESULT_ACTIONS = createPlannotatorResultActions();
const CORE_ACTIONS = createCoreActions();

/**
 * Coordinates workflow commands while delegating all external effects through
 * injectable dependencies.
 */
export class WorkflowHarness implements WorkflowCommandController {
  private readonly pi: ExtensionAPI;
  private readonly dependencies: WorkflowHarnessDependencies;
  private readonly delegationFailures: DelegationFailureActions;
  private readonly subagents: SubagentDelegationClientController;
  private readonly mainSteps: MainStepRuntimeController;
  private catalog: WorkflowCatalog = createEmptyCatalog();
  private run: WorkflowRun | undefined;
  private latestContext: ExtensionContext | undefined;
  private availableSkills = new Set<string>();
  private isSessionActive = false;
  private sessionEpoch = 0;
  private activeDelegation: ActiveDelegation | undefined;
  private activePromptReview: ActivePromptReview | undefined;
  private registeredWorkflowCommands = new Set<string>();
  private catalogLoadSequence = 0;
  private readonly mutationQueue: SerialTaskQueueController;
  private readonly statusShortcut: KeyId;
  private readonly statusShortcutLabel: string;
  private statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private isStatusOverlayOpen = false;
  private legacyProgressWidgetContext: ExtensionContext | undefined;
  private readonly workflowStatusSnapshot: () =>
    WorkflowStatusSnapshot | undefined = STATUS_ACTIONS.workflowStatusSnapshot;
  private readonly updateStatus: () => void = STATUS_ACTIONS.updateStatus;
  private readonly refreshStatusWhileRunning: () => void =
    STATUS_ACTIONS.refreshStatusWhileRunning;
  private readonly stopStatusRefresh: () => void =
    STATUS_ACTIONS.stopStatusRefresh;
  private readonly registerWorkflowStatusShortcut: () => void =
    STATUS_ACTIONS.registerWorkflowStatusShortcut;
  private readonly showWorkflowStatus: (
    context: ExtensionContext,
  ) => Promise<void> = STATUS_ACTIONS.showWorkflowStatus;
  private readonly listWorkflows: (
    context: ExtensionCommandContext,
  ) => Promise<void> = START_ACTIONS.listWorkflows;
  private readonly doctorWorkflows: (
    workflowId: string,
    context: ExtensionCommandContext,
  ) => Promise<void> = START_ACTIONS.doctorWorkflows;
  private readonly startNow: (
    workflowId: string,
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ) => Promise<void> = START_ACTIONS.startNow;
  private readonly restartNow: (
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ) => Promise<void> = START_ACTIONS.restartNow;
  private readonly reloadNow: (
    context: ExtensionCommandContext,
  ) => Promise<void> = START_ACTIONS.reloadNow;
  private readonly pauseNow: (
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void> = PAUSE_ACTIONS.pauseNow;
  private readonly abortNow: (
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void> = PAUSE_ACTIONS.abortNow;
  private readonly resumeNow: (
    context: ExtensionCommandContext,
    input?: string,
  ) => Promise<void> = RESUME_ACTION.resumeNow;
  private readonly registerMultilineCommandInput: () => void =
    LIFECYCLE_ACTIONS.registerMultilineCommandInput;
  private readonly registerLifecycle: () => void =
    LIFECYCLE_ACTIONS.registerLifecycle;
  private readonly registerPolicy: () => void =
    LIFECYCLE_ACTIONS.registerPolicy;
  private readonly launchCurrentStep: (
    workflow: LoadedWorkflow,
    recovery?: DelegationRecovery,
  ) => void = STEP_EXECUTION_ACTIONS.launchCurrentStep;
  private readonly launchMainStep: (
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    step: WorkflowStep,
  ) => void = STEP_EXECUTION_ACTIONS.launchMainStep;
  private readonly queueMainStepLog: (
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
  ) => Promise<void> = STEP_EXECUTION_ACTIONS.queueMainStepLog;
  private readonly recordMainStepLog: (
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
  ) => Promise<void> = STEP_EXECUTION_ACTIONS.recordMainStepLog;
  private readonly queueMainStepResult: (
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void> = STEP_EXECUTION_ACTIONS.queueMainStepResult;
  private readonly finishMainStep: (
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void> = STEP_EXECUTION_ACTIONS.finishMainStep;
  private readonly handleDelegationUpdate: (
    active: ActiveDelegation,
    update: SubagentDelegationUpdate,
  ) => void = DELEGATION_RESPONSE_ACTIONS.handleDelegationUpdate;
  private readonly queueDelegationResponse: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => void = DELEGATION_RESPONSE_ACTIONS.queueDelegationResponse;
  private readonly queueDelegationFailure: (
    active: ActiveDelegation,
    reason: string,
  ) => void = DELEGATION_RESPONSE_ACTIONS.queueDelegationFailure;
  private readonly finishDelegation: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => Promise<void> = DELEGATION_RESPONSE_ACTIONS.finishDelegation;
  private readonly cancelActiveDelegation: (
    reason: string,
  ) => Promise<boolean> = DELEGATION_CONTROL_ACTIONS.cancelActiveDelegation;
  private readonly cleanupDelegation: (
    active: ActiveDelegation,
  ) => Promise<void> = DELEGATION_CONTROL_ACTIONS.cleanupDelegation;
  private readonly retryDelegationAfterFailure: (
    active: ActiveDelegation,
    failure: DelegationFailureDetails | undefined,
    reason: string,
  ) => boolean = DELEGATION_CONTROL_ACTIONS.retryDelegationAfterFailure;
  private readonly pauseForDelegationFailure: (
    reason: string,
    failureSummary?: string,
  ) => void = DELEGATION_CONTROL_ACTIONS.pauseForDelegationFailure;
  private readonly pauseForExecutionFailure: (
    label: string,
    reason: string,
    failureSummary?: string,
  ) => void = DELEGATION_CONTROL_ACTIONS.pauseForExecutionFailure;
  private readonly retainUnconfirmedDelegation: (
    active: ActiveDelegation,
    reason: string,
  ) => void = DELEGATION_CONTROL_ACTIONS.retainUnconfirmedDelegation;
  private readonly releaseMainAfterCancellation: (
    active: ActiveDelegation,
  ) => void = DELEGATION_CONTROL_ACTIONS.releaseMainAfterCancellation;
  private readonly submitGate: (
    workflow: LoadedWorkflow,
    originalRun: WorkflowRun,
    outcome: string,
    summary: string,
    artifact: string,
  ) => Promise<void> = GATE_SUBMISSION_ACTION.submitGate;
  private readonly launchPromptReview: (
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    context: ExtensionContext | undefined,
  ) => void = PROMPT_GATE_ACTIONS.launchPromptReview;
  private readonly queuePromptReviewResult: (
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => void = PROMPT_GATE_ACTIONS.queuePromptReviewResult;
  private readonly queuePromptReviewFailure: (
    active: ActivePromptReview,
    reason: string,
  ) => void = PROMPT_GATE_ACTIONS.queuePromptReviewFailure;
  private readonly finishPromptReview: (
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ) => Promise<void> = PROMPT_GATE_ACTIONS.finishPromptReview;
  private readonly pausePromptGate: (
    requestId: string,
    reason: string,
    isFailed: boolean,
  ) => void = PROMPT_GATE_ACTIONS.pausePromptGate;
  private readonly cancelPromptReview: () => void =
    PROMPT_GATE_ACTIONS.cancelPromptReview;
  private readonly registerPlannotatorResults: () => void =
    PLANNOTATOR_RESULT_ACTIONS.registerPlannotatorResults;
  private readonly handlePlannotatorResult: (data: unknown) => Promise<void> =
    PLANNOTATOR_RESULT_ACTIONS.handlePlannotatorResult;
  private readonly settleAfterTransition: (
    workflow: LoadedWorkflow,
    report: SettledStepReport,
  ) => void = CORE_ACTIONS.settleAfterTransition;
  private readonly preflight: (
    workflow: LoadedWorkflow,
    stepId: string,
  ) => Array<string> = CORE_ACTIONS.preflight;
  private readonly isolateMainSessionTools: () => void =
    CORE_ACTIONS.isolateMainSessionTools;
  private readonly restoreBaselineTools: () => void =
    CORE_ACTIONS.restoreBaselineTools;
  private readonly captureSkills: (
    skills: ReadonlyArray<{ name: string }> | undefined,
  ) => void = CORE_ACTIONS.captureSkills;
  private readonly enqueueMutation: (
    context: ExtensionContext,
    operation: (sessionEpoch: number) => Promise<void>,
  ) => Promise<void> = CORE_ACTIONS.enqueueMutation;
  private readonly persist: () => void = CORE_ACTIONS.persist;
  private readonly restoreFromSession: (context: ExtensionContext) => void =
    CORE_ACTIONS.restoreFromSession;
  private readonly reloadCatalog: (
    context: ExtensionContext,
    shouldAnnounce: boolean,
  ) => Promise<boolean> = CORE_ACTIONS.reloadCatalog;

  /**
   * Creates a workflow harness and registers its Pi integration surface.
   *
   * @param pi - Pi extension API used by the runtime adapters.
   * @param statusShortcut - Shortcut used to open workflow status.
   * @param dependencyOverrides - Optional effect implementations for tests or
   * alternate runtimes.
   */
  constructor(
    pi: ExtensionAPI,
    statusShortcut: KeyId = DEFAULT_STATUS_SHORTCUT,
    dependencyOverrides: Partial<WorkflowHarnessDependencies> = {},
  ) {
    this.pi = pi;
    this.dependencies = createWorkflowHarnessDependencies(dependencyOverrides);
    this.delegationFailures = createDelegationFailureActions(this.dependencies);
    this.statusShortcut = statusShortcut;
    this.statusShortcutLabel = formatShortcutLabel(statusShortcut);
    this.subagents = this.dependencies.createSubagentClient(pi);
    this.mainSteps = this.dependencies.createMainStepRuntime(pi);
    this.mutationQueue = this.dependencies.createMutationQueue();
    registerHarnessCommands(pi, this);
    this.registerWorkflowStatusShortcut();
    this.registerMultilineCommandInput();
    this.registerLifecycle();
    this.registerPolicy();
    this.registerPlannotatorResults();
  }

  /** Returns the loaded workflow identifiers in stable display order. */
  workflowIds(): Array<string> {
    return [...this.catalog.workflows.keys()].sort();
  }

  /** Displays the currently loaded workflows. */
  async list(context: ExtensionCommandContext): Promise<void> {
    await this.listWorkflows(context);
  }

  /** Diagnoses declarative completion paths and loop risks. */
  async doctor(
    workflowId: string,
    context: ExtensionCommandContext,
  ): Promise<void> {
    await this.doctorWorkflows(workflowId, context);
  }

  /** Starts a loaded workflow with the supplied user input. */
  start(
    workflowId: string,
    input: string,
    context: ExtensionCommandContext,
  ): Promise<void> {
    return this.enqueueMutation(context, (sessionEpoch) =>
      this.startNow(
        workflowId,
        input,
        {
          context,
          skills: () => context.getSystemPromptOptions().skills,
          waitForIdle: () => context.waitForIdle(),
        },
        sessionEpoch,
      ),
    );
  }

  /** Starts another completed iteration in its existing workflow worktree. */
  restart(input: string, context: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(context, (sessionEpoch) =>
      this.restartNow(
        input,
        {
          context,
          skills: () => context.getSystemPromptOptions().skills,
          waitForIdle: () => context.waitForIdle(),
        },
        sessionEpoch,
      ),
    );
  }

  /** Pauses the active workflow while retaining its checkpoint. */
  pause(reason: string, context: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(context, () => this.pauseNow(reason, context));
  }

  /** Resumes the active paused workflow with optional user guidance. */
  resume(input: string, context: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(context, () => this.resumeNow(context, input));
  }

  /** Aborts the active workflow and cancels any delegated execution. */
  abort(reason: string, context: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(context, () => this.abortNow(reason, context));
  }

  /** Opens the workflow status overlay, matching the configured shortcut. */
  async status(context: ExtensionCommandContext): Promise<void> {
    this.latestContext = context;
    if (this.isStatusOverlayOpen) return;
    if (!this.run) {
      context.ui.notify('No workflow checkpoint in this session', 'info');
      return;
    }
    await this.showWorkflowStatus(context);
  }

  /** Reloads workflow configuration while no workflow is executing. */
  reload(context: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(context, () => this.reloadNow(context));
  }
}
