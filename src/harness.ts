import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import {
  registerHarnessCommands,
  type WorkflowCommandController,
} from './commands.ts';
import { loadCatalog } from './config/load.ts';
import { hasRuntimeCommandConflict } from './config/command-conflicts.ts';
import {
  DEFAULT_SETTINGS,
  type LoadedWorkflow,
  type WorkflowCatalog,
  type WorkflowStep,
} from './config/types.ts';
import { digest } from './digest.ts';
import {
  abortRun,
  advanceRun,
  allowedOutcomes,
  attachGateReviewId,
  beginGate,
  failGate,
  failRun,
  pauseRun,
  reconcileRun,
  resolveGate,
  resumeRun,
  storeGateResolution,
} from './engine/transitions.ts';
import {
  createRun,
  type GateResolution,
  type WorkflowRun,
} from './engine/state.ts';
import { readLatestCheckpoint } from './engine/checkpoint.ts';
import {
  captureResumeCheckpoint,
  matchesResumeCheckpoint,
} from './engine/resume.ts';
import {
  parsePlannotatorResult,
  PLANNOTATOR_RESULT_CHANNEL,
  requestPlannotatorReview,
  requestPlannotatorReviewStatus,
} from './integrations/plannotator.ts';
import {
  requestPromptGateReview,
  type PromptGateReviewResult,
} from './integrations/prompt-gate.ts';
import { SubagentDelegationClient } from './integrations/subagents/client.ts';
import {
  encodeChildPolicy,
  parseDelegatedStepResult,
  type ChildStepPolicy,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from './integrations/subagents/protocol.ts';
import {
  deriveSubagentSessionRoot,
  failedToolName,
  formatToolFailureDiagnostic,
  readToolFailureDiagnostic,
  type ToolFailureDiagnostic,
} from './integrations/subagents/diagnostics.ts';
import { preflightStep } from './preflight.ts';
import {
  buildDelegatedStepTask,
  buildMainStepTask,
  buildMainWorkflowNotice,
  toolRetryTask,
} from './prompt.ts';
import {
  narrowApprovedBashCommands,
  resolveReviewedRepositoryCwd,
  reviewedCommandShapeError,
} from './policy/approved-commands.ts';
import {
  MainStepRuntime,
  type MainStepExecution,
} from './runtime/main-step-runtime.ts';
import { WORKFLOW_COMPLETION_PARAMETERS } from './runtime/completion-tool.ts';
import { SerialTaskQueue } from './runtime/serial-task-queue.ts';
import type { WorkflowStepResult } from './runtime/step-result.ts';
import { formatWorkflowList } from './workflow-list.ts';
import {
  showWorkflowStatus as showWorkflowStatusOverlay,
  workflowStatusIcon,
  type WorkflowStatusExecution,
  type WorkflowStatusSnapshot,
} from './workflow-status.ts';

const STATE_ENTRY_TYPE = 'pi-workflows-state-v1';
const STATUS_KEY = 'pi-workflows';
const LEGACY_PROGRESS_WIDGET_KEY = 'pi-workflows-progress';
const STATUS_REFRESH_INTERVAL_MS = 250;
const MAX_TOOL_FAILURE_RETRIES = 1;

function isRetryableToolFailure(reason: string): boolean {
  return failedToolName(reason) !== undefined;
}

function isSafeToRetryDelegation(
  policy: ChildStepPolicy,
  replayExplicitlyAuthorized: boolean,
  diagnostic: ToolFailureDiagnostic | undefined,
): boolean {
  const tools = new Set(policy.permissions.tools);
  return (
    diagnostic?.replaySafe === true &&
    !tools.has('edit') &&
    !tools.has('write') &&
    (replayExplicitlyAuthorized ||
      policy.permissions.bash.mode === 'deny' ||
      policy.permissions.bash.mode === 'read-only')
  );
}

interface ActiveDelegation {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
  resultDirectory: string;
  policy: ChildStepPolicy;
  agent: string;
  trustedSessionRoot?: string;
  retryToolFailures: boolean;
  toolFailureRetryCount: number;
  retryDiagnostic?: ToolFailureDiagnostic;
  progress?: string;
  cancelling?: boolean;
}

const MAX_FAILURE_FIELD_CHARS = 1_600;

function boundedFailureField(value: string): string {
  if (value.length <= MAX_FAILURE_FIELD_CHARS) return value;
  const marker = '… [truncated] …';
  const available = MAX_FAILURE_FIELD_CHARS - marker.length - 2;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}\n${marker}\n${value.slice(-endLength)}`;
}

function rejectedRecoveryReason(
  failure: DelegationFailureDetails,
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${failure.reason}\nRecovery rejected: ${boundedFailureField(detail)}`;
}

function completionMatchesResult(
  diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
  result: WorkflowStepResult,
  policy: ChildStepPolicy,
): boolean {
  const value = diagnostic.completionValue;
  if (!value) return false;
  const expectedKeys = [
    'outcome',
    'summary',
    ...(result.artifact === undefined ? [] : ['artifact']),
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    return false;
  }
  try {
    const completion = parseDelegatedStepResult(
      {
        ...value,
        version: 1,
        policyDigest: policy.policyDigest,
      },
      policy,
    );
    return (
      completion.outcome === result.outcome &&
      completion.summary === result.summary &&
      completion.artifact === result.artifact
    );
  } catch {
    return false;
  }
}

function recoveredProjectionError(
  active: ActiveDelegation,
  response: SubagentDelegationResponse,
  diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
): string | undefined {
  if (response.agent !== active.agent) {
    return `terminal agent identity is ${JSON.stringify(response.agent)}; expected ${JSON.stringify(active.agent)}`;
  }
  if (response.childIndex !== 0) {
    return `terminal child index is ${JSON.stringify(response.childIndex)}; expected 0`;
  }
  if (
    typeof response.exitCode !== 'number' ||
    !Number.isSafeInteger(response.exitCode) ||
    response.exitCode <= 0
  ) {
    return `terminal exit code is ${JSON.stringify(response.exitCode)}; expected a positive safe integer`;
  }
  const execution = response.execution;
  if (!execution) return 'terminal response has no execution projection';
  if (execution.status !== 'failed' || execution.success !== false) {
    return `execution projection is ${JSON.stringify({
      status: execution.status,
      success: execution.success,
    })}; expected failed/false`;
  }
  if (execution.exitCode !== response.exitCode) {
    return `execution exit code ${JSON.stringify(execution.exitCode)} does not match terminal exit code ${JSON.stringify(response.exitCode)}`;
  }
  if (
    typeof response.error !== 'string' ||
    !response.error ||
    typeof execution.error !== 'string' ||
    execution.error !== response.error
  ) {
    return 'terminal and execution errors are missing or do not match exactly';
  }
  const toolFailure = response.error.match(
    /^\s*([a-z][\w-]*) failed\s*\(exit\s+(\d+)\)\s*:/i,
  );
  if (!toolFailure) {
    return 'terminal error is not a recognized "<tool> failed (exit N): <detail>" failure';
  }
  const terminalTool = toolFailure[1]!;
  const terminalExitCode = Number(toolFailure[2]);
  if (
    terminalTool.toLowerCase() !== diagnostic.tool.toLowerCase() ||
    terminalExitCode !== response.exitCode
  ) {
    return `terminal tool/exit ${JSON.stringify({
      tool: terminalTool,
      exitCode: terminalExitCode,
    })} does not match the correlated failure ${JSON.stringify({
      tool: diagnostic.tool,
      exitCode: response.exitCode,
    })}`;
  }
  const unsafeFlag = (
    [
      ['interrupted', execution.interrupted],
      ['timedOut', execution.timedOut],
      ['stopped', execution.stopped],
      ['detached', execution.detached],
    ] as const
  ).find(([, enabled]) => enabled === true)?.[0];
  return unsafeFlag
    ? `execution projection reports ${unsafeFlag}=true`
    : undefined;
}

interface DelegationFailureDetails {
  reason: string;
  diagnostic?: Awaited<ReturnType<typeof readToolFailureDiagnostic>>;
}

async function delegationFailureDetails(
  active: ActiveDelegation,
  response: SubagentDelegationResponse,
): Promise<DelegationFailureDetails> {
  const error =
    response.error ??
    response.execution?.error ??
    'The subagent returned no terminal error details.';
  const diagnostic = await readToolFailureDiagnostic(
    response.sessionFile,
    active.trustedSessionRoot,
    response.runId !== undefined && response.childIndex !== undefined
      ? { runId: response.runId, childIndex: response.childIndex }
      : undefined,
    failedToolName(error),
    error,
  );
  const exitCode = response.exitCode ?? response.execution?.exitCode;
  const reason = [
    `Subagent "${active.agent}" ${response.status.replaceAll('_', ' ')}.`,
    ...(diagnostic ? formatToolFailureDiagnostic(diagnostic) : []),
    ...(exitCode !== undefined ? [`Subagent exit code: ${exitCode}`] : []),
    `Terminal error: ${boundedFailureField(error)}`,
    ...(diagnostic && response.sessionFile
      ? [
          `Diagnostic session: ${boundedFailureField(response.sessionFile.replaceAll(/\s+/g, ' '))}`,
        ]
      : []),
  ].join('\n');
  return {
    reason,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

interface MainStepIdentity {
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
}

interface ActivePromptReview {
  requestId: string;
  runId: string;
  stepId: string;
  sessionEpoch: number;
  abortController: AbortController;
}

interface WorkflowStartContext {
  context: ExtensionContext;
  skills: () => readonly { name: string }[] | undefined;
  waitForIdle: () => Promise<void>;
}

function emptyCatalog(): WorkflowCatalog {
  return {
    workflows: new Map(),
    settings: DEFAULT_SETTINGS,
    diagnostics: [],
    userDirectory: '',
  };
}

function formatDiagnostics(catalog: WorkflowCatalog): string {
  const shown = catalog.diagnostics
    .slice(0, 3)
    .map((item) => `${item.path}: ${item.message}`);
  const remaining = catalog.diagnostics.length - shown.length;
  return [
    ...shown,
    ...(remaining > 0 ? [`${remaining} more diagnostic(s)`] : []),
  ].join('\n');
}

function skillNamesFromSystemPrompt(
  systemPrompt: string,
): Array<{ name: string }> {
  const sections = [
    ...systemPrompt.matchAll(
      /<available_skills>([\s\S]*?)<\/available_skills>/g,
    ),
  ];
  const section = sections.at(-1)?.[1] ?? '';
  return [...section.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => ({
    name: match[1]!.trim(),
  }));
}

async function waitForEventContextIdle(ctx: ExtensionContext): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ctx.isIdle()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the interrupted Pi turn to stop');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export class WorkflowHarness implements WorkflowCommandController {
  private readonly pi: ExtensionAPI;
  private readonly subagents: SubagentDelegationClient;
  private readonly mainSteps: MainStepRuntime;
  private catalog: WorkflowCatalog = emptyCatalog();
  private run: WorkflowRun | undefined;
  private latestContext: ExtensionContext | undefined;
  private availableSkills = new Set<string>();
  private sessionActive = false;
  private sessionEpoch = 0;
  private activeDelegation: ActiveDelegation | undefined;
  private activePromptReview: ActivePromptReview | undefined;
  private registeredWorkflowCommands = new Set<string>();
  private catalogLoadSequence = 0;
  private readonly mutationQueue = new SerialTaskQueue();
  private statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private statusOverlayOpen = false;
  private legacyProgressWidgetContext: ExtensionContext | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.subagents = new SubagentDelegationClient(pi.events);
    this.mainSteps = new MainStepRuntime(pi);
    registerHarnessCommands(pi, this);
    this.registerWorkflowStatusShortcut();
    this.registerMultilineCommandInput();
    this.registerLifecycle();
    this.registerPolicy();
    this.registerPlannotatorResults();
  }

  workflowIds(): string[] {
    return [...this.catalog.workflows.keys()].sort();
  }

  private registerMultilineCommandInput(): void {
    this.pi.on('input', async (event, ctx) => {
      if (
        event.source === 'extension' ||
        event.images?.length ||
        !event.text.startsWith('/')
      ) {
        return;
      }
      const newline = event.text.indexOf('\n');
      if (newline === -1) return;
      const command = event.text.slice(1, newline).replace(/\r$/, '');
      if (!this.registeredWorkflowCommands.has(command)) return;
      const workflow = [...this.catalog.workflows.values()].find(
        (candidate) => candidate.definition.command === command,
      );
      if (!workflow) return;

      const input = event.text.slice(newline + 1);
      const skills = skillNamesFromSystemPrompt(ctx.getSystemPrompt());
      try {
        await this.enqueueMutation(ctx, (sessionEpoch) =>
          this.startNow(
            workflow.definition.id,
            input,
            {
              context: ctx,
              skills: () => skills,
              waitForIdle: () => waitForEventContextIdle(ctx),
            },
            sessionEpoch,
          ),
        );
      } catch (error) {
        ctx.ui.notify(
          `Cannot start workflow: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
      return { action: 'handled' as const };
    });
  }

  async list(ctx: ExtensionCommandContext): Promise<void> {
    const workflows = [...this.catalog.workflows.values()].sort((left, right) =>
      left.definition.id.localeCompare(right.definition.id),
    );
    if (workflows.length === 0) {
      ctx.ui.notify(
        `No workflows loaded from ${this.catalog.userDirectory}`,
        this.catalog.diagnostics.length > 0 ? 'warning' : 'info',
      );
      return;
    }
    this.pi.sendMessage({
      customType: 'workflow-list',
      content: formatWorkflowList(
        workflows.map((workflow) => workflow.definition),
      ),
      display: true,
    });
  }

  start(
    workflowId: string,
    input: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    return this.enqueueMutation(ctx, (sessionEpoch) =>
      this.startNow(
        workflowId,
        input,
        {
          context: ctx,
          skills: () => ctx.getSystemPromptOptions().skills,
          waitForIdle: () => ctx.waitForIdle(),
        },
        sessionEpoch,
      ),
    );
  }

  private async startNow(
    workflowId: string,
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ): Promise<void> {
    const { context: ctx } = startContext;
    if (this.activeDelegation) {
      ctx.ui.notify(
        `Cannot start a workflow while subagent "${this.activeDelegation.agent}" is still cancelling`,
        'warning',
      );
      return;
    }
    if (
      this.run &&
      this.run.status !== 'completed' &&
      this.run.status !== 'aborted'
    ) {
      ctx.ui.notify(
        `Workflow "${this.run.workflowId}" is ${this.run.status}; resume or abort it first`,
        'warning',
      );
      return;
    }
    if (!ctx.isIdle()) {
      ctx.abort();
      await startContext.waitForIdle();
    }
    if (!this.sessionActive || this.sessionEpoch !== sessionEpoch) {
      ctx.ui.notify(
        'Workflow start was superseded by a session change',
        'warning',
      );
      return;
    }

    this.captureSkills(startContext.skills());
    if (!(await this.reloadCatalog(ctx, false))) {
      ctx.ui.notify(
        'Workflow start was superseded by a newer configuration load',
        'warning',
      );
      return;
    }
    if (!this.sessionActive || this.sessionEpoch !== sessionEpoch) {
      ctx.ui.notify(
        'Workflow start was superseded by a session change',
        'warning',
      );
      return;
    }
    const workflow = this.catalog.workflows.get(workflowId);
    if (!workflow) {
      ctx.ui.notify(`Workflow "${workflowId}" is not loaded`, 'error');
      return;
    }
    const preflightErrors = this.preflight(workflow, workflow.definition.start);
    if (preflightErrors.length > 0) {
      ctx.ui.notify(
        `Cannot start workflow:\n${preflightErrors.join('\n')}`,
        'error',
      );
      return;
    }

    const baselineTools = this.pi.getActiveTools();
    this.run = createRun(
      workflow,
      input.trim(),
      baselineTools,
      randomUUID(),
      Date.now(),
    );
    this.persist();
    this.isolateMainSessionTools();
    this.updateStatus();
    this.openWorkflowStatus(ctx);
    this.launchCurrentStep(workflow);
  }

  pause(reason: string, ctx: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(ctx, () => this.pauseNow(reason, ctx));
  }

  private async pauseNow(
    reason: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (
      !this.run ||
      this.run.status === 'completed' ||
      this.run.status === 'aborted'
    ) {
      ctx.ui.notify('No active workflow to pause', 'warning');
      return;
    }
    if (this.run.status === 'paused') {
      ctx.ui.notify(
        `Workflow is already paused${this.run.pauseReason ? `: ${this.run.pauseReason}` : ''}`,
        'info',
      );
      return;
    }
    this.cancelPromptReview();
    const mainSuspended = this.mainSteps.suspend();
    const cancellationConfirmed = await this.cancelActiveDelegation(
      'Workflow paused by user',
    );
    if (!ctx.isIdle()) {
      ctx.abort();
      if (mainSuspended) await ctx.waitForIdle();
    }

    this.run = pauseRun(this.run, reason, Date.now());
    this.persist();
    if (cancellationConfirmed) {
      this.restoreBaselineTools();
    } else {
      this.isolateMainSessionTools();
    }
    this.updateStatus();
    ctx.ui.notify(
      cancellationConfirmed
        ? `Paused "${this.run.workflowId}" at step "${this.run.currentStepId}". Fix the issue, then run /workflow-resume.`
        : `Pause recorded at "${this.run.currentStepId}", but child cancellation is not confirmed. Main tools remain isolated until it exits.`,
      cancellationConfirmed ? 'info' : 'warning',
    );
  }

  resume(ctx: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(ctx, () => this.resumeNow(ctx));
  }

  private async resumeNow(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.run || this.run.status !== 'paused') {
      ctx.ui.notify('No paused workflow to resume', 'warning');
      return;
    }
    if (this.activeDelegation) {
      ctx.ui.notify(
        `Cannot resume while subagent "${this.activeDelegation.agent}" is still cancelling`,
        'warning',
      );
      return;
    }
    const checkpoint = captureResumeCheckpoint(this.run, this.sessionEpoch);
    if (!ctx.isIdle()) {
      ctx.abort();
      await ctx.waitForIdle();
    }
    if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
      ctx.ui.notify(
        'Resume was superseded by another workflow or session change',
        'warning',
      );
      return;
    }
    this.captureSkills(ctx.getSystemPromptOptions().skills);
    await this.reloadCatalog(ctx, false);
    if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
      ctx.ui.notify(
        'Resume was superseded by another workflow or session change',
        'warning',
      );
      return;
    }

    let workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) {
      ctx.ui.notify(
        `Workflow "${this.run.workflowId}" is no longer loaded; restore it or abort`,
        'error',
      );
      return;
    }
    const reconciled = reconcileRun(this.run, workflow, Date.now());
    if (!reconciled.run) {
      ctx.ui.notify(
        reconciled.error ?? 'Cannot reconcile workflow configuration',
        'error',
      );
      return;
    }

    let resumed = reconciled.run;
    if (
      resumed.pendingGate?.provider === 'plannotator' &&
      !resumed.pendingGate.reviewId
    ) {
      resumed = failGate(
        resumed,
        'Gate submission was interrupted before a review id was recorded; submit it again',
        Date.now(),
      );
    }
    if (
      resumed.pendingGate?.provider === 'plannotator' &&
      resumed.pendingGate.reviewId &&
      !resumed.pendingGate.resolution
    ) {
      const requestedReviewId = resumed.pendingGate.reviewId;
      const gateStep = workflow.definition.steps[resumed.pendingGate.stepId];
      const statusResponse = await requestPlannotatorReviewStatus(
        this.pi.events,
        `${resumed.runId}:review-status:${randomUUID()}`,
        requestedReviewId,
        gateStep?.gate?.provider === 'plannotator'
          ? gateStep.gate.timeoutMs
          : 5_000,
      );
      if (!matchesResumeCheckpoint(this.run, this.sessionEpoch, checkpoint)) {
        ctx.ui.notify(
          'Resume was superseded by another workflow or session change',
          'warning',
        );
        return;
      }

      workflow = this.catalog.workflows.get(this.run.workflowId);
      if (!workflow) {
        ctx.ui.notify(
          `Workflow "${this.run.workflowId}" is no longer loaded; restore it or abort`,
          'error',
        );
        return;
      }
      const latest = reconcileRun(this.run, workflow, Date.now());
      if (!latest.run) {
        ctx.ui.notify(
          latest.error ?? 'Cannot reconcile workflow configuration',
          'error',
        );
        return;
      }
      resumed = latest.run;

      if (
        !resumed.pendingGate?.resolution &&
        resumed.pendingGate?.reviewId === requestedReviewId &&
        statusResponse.status !== 'handled'
      ) {
        ctx.ui.notify(
          statusResponse.error ?? 'Cannot query the pending Plannotator review',
          'error',
        );
        return;
      }
      if (
        !resumed.pendingGate?.resolution &&
        resumed.pendingGate?.reviewId === requestedReviewId &&
        statusResponse.status === 'handled' &&
        statusResponse.result.status === 'completed'
      ) {
        resumed = storeGateResolution(
          resumed,
          {
            approved: statusResponse.result.approved,
            feedback: statusResponse.result.feedback,
            resolvedAt: Date.now(),
          },
          Date.now(),
        );
      } else if (
        !resumed.pendingGate?.resolution &&
        resumed.pendingGate?.reviewId === requestedReviewId &&
        statusResponse.status === 'handled' &&
        statusResponse.result.status === 'missing'
      ) {
        resumed = failGate(
          resumed,
          'Plannotator no longer has the pending review; submit it again',
          Date.now(),
        );
      }
    }
    const storedResolution = resumed.pendingGate?.resolution;
    if (storedResolution) {
      try {
        resumed = resolveGate(workflow, resumed, storedResolution, Date.now());
      } catch (error) {
        ctx.ui.notify(
          `Cannot apply stored gate result: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return;
      }
    } else {
      resumed = resumeRun(resumed, Date.now());
    }
    this.run = resumed;

    if (this.run.status === 'awaiting-gate') {
      this.persist();
      this.restoreBaselineTools();
      this.updateStatus();
      if (this.run.pendingGate?.provider === 'prompt') {
        this.launchPromptReview(workflow, this.run, ctx);
        ctx.ui.notify('Workflow resumed with built-in review open', 'info');
        return;
      }
      ctx.ui.notify(
        `Workflow resumed and is waiting for review ${this.run.pendingGate?.reviewId ?? ''}`.trim(),
        'info',
      );
      return;
    }
    if (this.run.status !== 'running') {
      this.persist();
      this.restoreBaselineTools();
      this.updateStatus();
      ctx.ui.notify(`Workflow is now ${this.run.status}`, 'info');
      return;
    }

    const preflightErrors = this.preflight(workflow, this.run.currentStepId);
    if (preflightErrors.length > 0) {
      this.run = failRun(
        this.run,
        `Step preflight failed: ${preflightErrors.join('; ')}`,
        Date.now(),
      );
      this.persist();
      this.restoreBaselineTools();
      this.updateStatus();
      ctx.ui.notify(
        `Cannot resume workflow:\n${preflightErrors.join('\n')}`,
        'error',
      );
      return;
    }

    this.persist();
    this.isolateMainSessionTools();
    this.updateStatus();
    this.launchCurrentStep(workflow);
  }

  abort(reason: string, ctx: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(ctx, () => this.abortNow(reason, ctx));
  }

  private async abortNow(
    reason: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (
      !this.run ||
      this.run.status === 'completed' ||
      this.run.status === 'aborted'
    ) {
      ctx.ui.notify('No active workflow to abort', 'warning');
      return;
    }
    this.cancelPromptReview();
    const mainSuspended = this.mainSteps.suspend();
    const cancellationConfirmed = await this.cancelActiveDelegation(
      'Workflow aborted by user',
    );
    if (!ctx.isIdle()) {
      ctx.abort();
      if (mainSuspended) await ctx.waitForIdle();
    }
    this.run = abortRun(this.run, reason, Date.now());
    this.persist();
    if (cancellationConfirmed) {
      this.restoreBaselineTools();
    } else {
      this.isolateMainSessionTools();
    }
    this.updateStatus();
    ctx.ui.notify(
      cancellationConfirmed
        ? `Aborted workflow "${this.run.workflowId}"`
        : `Workflow "${this.run.workflowId}" is aborted, but its child has not confirmed cancellation; main tools remain isolated`,
      cancellationConfirmed ? 'info' : 'warning',
    );
  }

  reload(ctx: ExtensionCommandContext): Promise<void> {
    return this.enqueueMutation(ctx, () => this.reloadNow(ctx));
  }

  private async reloadNow(ctx: ExtensionCommandContext): Promise<void> {
    if (
      this.run &&
      (this.run.status === 'running' || this.run.status === 'awaiting-gate')
    ) {
      ctx.ui.notify(
        'Pause the workflow before reloading its configuration',
        'warning',
      );
      return;
    }
    this.captureSkills(ctx.getSystemPromptOptions().skills);
    await this.reloadCatalog(ctx, true);
  }

  private workflowStatusSnapshot(): WorkflowStatusSnapshot | undefined {
    if (!this.run) return undefined;
    const workflow = this.catalog.workflows.get(this.run.workflowId);
    let execution: WorkflowStatusExecution | undefined;
    if (this.activeDelegation) {
      execution = {
        kind: 'subagent',
        agent: this.activeDelegation.agent,
        requestId: this.activeDelegation.requestId,
        progress: this.activeDelegation.progress ?? 'starting',
      };
    } else if (this.mainSteps.activeStepId) {
      execution = { kind: 'main' };
    }
    return {
      run: this.run,
      now: Date.now(),
      ...(workflow ? { workflow } : {}),
      ...(execution ? { execution } : {}),
    };
  }

  private registerLifecycle(): void {
    this.pi.on('session_start', async (_event, ctx) => {
      this.sessionEpoch += 1;
      this.sessionActive = false;
      this.cancelPromptReview();
      this.mainSteps.deactivate();
      await this.cancelActiveDelegation('Pi session changed');
      if (this.run) this.restoreBaselineTools();
      this.run = undefined;
      this.latestContext = ctx;
      if (!(await this.reloadCatalog(ctx, false))) return;
      this.restoreFromSession(ctx);
      this.sessionActive = true;
    });

    this.pi.on('session_tree', async (_event, ctx) => {
      this.sessionEpoch += 1;
      this.sessionActive = false;
      this.cancelPromptReview();
      this.mainSteps.deactivate();
      await this.cancelActiveDelegation('Pi session tree changed');
      this.latestContext = ctx;
      if (!(await this.reloadCatalog(ctx, false))) return;
      this.restoreFromSession(ctx);
      this.sessionActive = true;
    });

    this.pi.on('session_shutdown', async () => {
      this.sessionEpoch += 1;
      this.sessionActive = false;
      this.cancelPromptReview();
      this.mainSteps.deactivate();
      await this.cancelActiveDelegation('Pi session shut down');
      if (this.run) this.restoreBaselineTools();
      this.run = undefined;
      this.latestContext = undefined;
      this.stopStatusRefresh();
    });
  }

  private registerPolicy(): void {
    this.pi.on('before_agent_start', (event, ctx) => {
      this.latestContext = ctx;
      this.captureSkills(event.systemPromptOptions.skills);
      if (!this.run || this.run.status !== 'running') return;
      const workflow = this.catalog.workflows.get(this.run.workflowId);
      if (!workflow) {
        this.run = failRun(
          this.run,
          'Workflow configuration disappeared; reload or restore it',
          Date.now(),
        );
        this.persist();
        this.restoreBaselineTools();
        this.updateStatus();
        return;
      }
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildMainWorkflowNotice(workflow, this.run)}`,
      };
    });
  }

  private launchCurrentStep(
    workflow: LoadedWorkflow,
    toolRetry?: { count: number; reason: string },
  ): void {
    const run = this.run;
    if (
      !run ||
      run.status !== 'running' ||
      this.activeDelegation ||
      this.mainSteps.activeStepId
    ) {
      return;
    }
    const step = workflow.definition.steps[run.currentStepId];
    if (!step) {
      this.pauseForExecutionFailure(
        'Workflow',
        `Step "${run.currentStepId}" is missing from the workflow`,
      );
      return;
    }
    const subagent = step.subagent;
    if (!subagent) {
      this.launchMainStep(workflow, run, step);
      return;
    }

    const reviewedRepository = resolveReviewedRepositoryCwd(
      run.reviewedArtifact ?? '',
    );
    if (reviewedRepository.kind === 'invalid') {
      this.pauseForExecutionFailure('Subagent step', reviewedRepository.reason);
      return;
    }
    const delegationCwd =
      reviewedRepository.kind === 'resolved'
        ? reviewedRepository.cwd
        : (this.latestContext?.cwd ?? process.cwd());
    const runtimeAgent = subagent.agent;
    const requestId = `${run.runId}:${run.currentStepId}:${randomUUID()}`;
    const resultDirectory = mkdtempSync(join(tmpdir(), 'pi-workflows-step-'));
    const capabilityPath = join(resultDirectory, 'capability');
    const capabilityToken = randomBytes(32).toString('hex');
    const resultPath = join(resultDirectory, 'result.json');
    writeFileSync(capabilityPath, capabilityToken, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const outcomes = allowedOutcomes(workflow, run);
    const outcomeSet = new Set(outcomes);
    const approvedBashCommands = narrowApprovedBashCommands(
      run.reviewedArtifact ?? '',
      run.stepHandoff ?? '',
      step.permissions.bash.approvedSources ?? [],
    );
    const repositoryPolicy =
      reviewedRepository.kind === 'resolved'
        ? {
            repositoryCwd: reviewedRepository.repositoryCwd,
            ...(reviewedRepository.bootstrapping
              ? { bootstrapCwd: reviewedRepository.cwd }
              : {}),
          }
        : {};
    const policyDigest = digest({
      version: 1,
      requestId,
      agent: runtimeAgent,
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      capabilityPath,
      resultPath,
      approvedBashCommands,
      ...repositoryPolicy,
    });
    const policy: ChildStepPolicy = {
      version: 1,
      requestId,
      agent: runtimeAgent,
      workflowId: workflow.definition.id,
      runId: run.runId,
      stepId: run.currentStepId,
      stepTitle: step.title,
      policyDigest,
      capabilityPath,
      capabilityToken,
      resultPath,
      permissions: structuredClone(step.permissions),
      ...(approvedBashCommands.length > 0 ? { approvedBashCommands } : {}),
      ...repositoryPolicy,
      outcomes,
      pauseOutcomes: Object.entries(step.transitions)
        .filter(
          ([outcome, target]) => target === '$pause' && outcomeSet.has(outcome),
        )
        .map(([outcome]) => outcome),
      summaryMaxChars: workflow.definition.summaryMaxChars,
      ...(step.gate ? { gateSubmitOutcome: step.gate.submitOutcome } : {}),
    };
    const trustedSessionRoot = deriveSubagentSessionRoot(
      this.latestContext?.sessionManager.getSessionFile(),
    );
    const active: ActiveDelegation = {
      requestId,
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      sessionEpoch: this.sessionEpoch,
      resultDirectory,
      policy,
      agent: subagent.agent,
      ...(trustedSessionRoot ? { trustedSessionRoot } : {}),
      retryToolFailures: subagent.retryToolFailures,
      toolFailureRetryCount: toolRetry?.count ?? 0,
    };
    const request: SubagentDelegationRequest = {
      version: 1,
      requestId,
      agent: runtimeAgent,
      task: [
        buildDelegatedStepTask(workflow, run, encodeChildPolicy(policy)),
        ...(toolRetry ? [toolRetryTask(toolRetry.reason)] : []),
      ].join('\n\n'),
      // Workflow steps are isolation boundaries. Never fork the parent or a
      // sibling step's transcript; pass only the explicit workflow handoff.
      context: 'fresh',
      cwd: delegationCwd,
      timeoutMs: subagent.timeoutMs,
      skill:
        step.permissions.skills.length > 0
          ? [...step.permissions.skills]
          : false,
      output: false,
      outputSchema: WORKFLOW_COMPLETION_PARAMETERS as unknown as Record<
        string,
        unknown
      >,
      agentContract: { version: 1 },
      artifacts: subagent.artifacts,
      ...(subagent.model ? { model: subagent.model } : {}),
      ...(subagent.turnBudget
        ? { turnBudget: structuredClone(subagent.turnBudget) }
        : {}),
      ...(subagent.toolBudget
        ? { toolBudget: structuredClone(subagent.toolBudget) }
        : {}),
    };

    this.activeDelegation = active;
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Delegated "${run.currentStepId}" to subagent "${subagent.agent}"`,
      'info',
    );
    void this.subagents
      .delegate(request, {
        onUpdate: (update) => this.handleDelegationUpdate(active, update),
        onLateTerminal: (response) =>
          this.queueDelegationResponse(active, response),
      })
      .then(
        (response) => this.queueDelegationResponse(active, response),
        (error: unknown) =>
          this.queueDelegationFailure(
            active,
            error instanceof Error ? error.message : String(error),
          ),
      );
  }

  private launchMainStep(
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    step: WorkflowStep,
  ): void {
    const approvedBashCommands = narrowApprovedBashCommands(
      run.reviewedArtifact ?? '',
      run.stepHandoff ?? '',
      step.permissions.bash.approvedSources ?? [],
    );
    const identity: MainStepIdentity = {
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      sessionEpoch: this.sessionEpoch,
    };
    const policyDigest = digest({
      version: 1,
      execution: 'main',
      workflowId: workflow.definition.id,
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      permissions: step.permissions,
      approvedBashCommands,
      nonce: randomUUID(),
    });
    const execution: MainStepExecution = {
      workflowId: workflow.definition.id,
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      policyDigest,
      step: structuredClone(step),
      approvedBashCommands,
      outcomes: allowedOutcomes(workflow, run),
      summaryMaxChars: workflow.definition.summaryMaxChars,
      ...(step.gate ? { gateSubmitOutcome: step.gate.submitOutcome } : {}),
      onSettled: (result, context) =>
        this.queueMainStepResult(identity, result, context),
    };

    try {
      this.mainSteps.activate(execution);
      this.updateStatus();
      this.latestContext?.ui.notify(
        `Started "${run.currentStepId}" in the main agent`,
        'info',
      );
      this.pi.sendUserMessage(buildMainStepTask(workflow, run), {
        deliverAs: 'followUp',
      });
    } catch (error) {
      this.mainSteps.deactivate();
      this.pauseForExecutionFailure(
        'Main-agent step',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private queueMainStepResult(
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ): Promise<void> {
    return this.mutationQueue
      .run(() => this.finishMainStep(identity, result, context))
      .catch((error: unknown) => {
        this.pauseForExecutionFailure(
          'Main-agent step',
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  private async finishMainStep(
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ): Promise<void> {
    this.latestContext = context;
    if (
      !this.sessionActive ||
      this.sessionEpoch !== identity.sessionEpoch ||
      !this.run ||
      this.run.status !== 'running' ||
      this.run.runId !== identity.runId ||
      this.run.currentStepId !== identity.stepId ||
      this.run.currentStepDigest !== identity.stepDigest
    ) {
      return;
    }
    if (!result) {
      throw new Error(
        'agent settled without calling workflow_complete_step exactly once',
      );
    }

    const workflow = this.catalog.workflows.get(this.run.workflowId);
    const step = workflow?.definition.steps[this.run.currentStepId];
    if (!workflow || !step) {
      throw new Error('Active workflow configuration is unavailable');
    }
    if (step.gate?.submitOutcome === result.outcome) {
      await this.submitGate(
        workflow,
        this.run,
        result.outcome,
        result.artifact ?? '',
      );
      return;
    }

    this.run = advanceRun(
      workflow,
      this.run,
      result.outcome,
      result.summary,
      Date.now(),
    );
    this.settleAfterTransition(workflow);
  }

  private handleDelegationUpdate(
    active: ActiveDelegation,
    update: SubagentDelegationUpdate,
  ): void {
    if (this.activeDelegation !== active) return;
    const progress = [
      update.currentTool ? `tool ${update.currentTool}` : undefined,
      update.toolCount !== undefined ? `${update.toolCount} calls` : undefined,
      update.tokens !== undefined ? `${update.tokens} tokens` : undefined,
    ].filter((part): part is string => part !== undefined);
    active.progress = progress.join(', ') || 'running';
    this.updateStatus();
  }

  private queueDelegationResponse(
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ): void {
    void this.mutationQueue
      .run(() => this.finishDelegation(active, response))
      .catch((error: unknown) => {
        this.pauseForDelegationFailure(
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  private queueDelegationFailure(
    active: ActiveDelegation,
    reason: string,
  ): void {
    void this.mutationQueue
      .run(async () => {
        if (this.activeDelegation !== active) {
          await this.cleanupDelegation(active);
          return;
        }
        if (this.subagents.activeRequestId === active.requestId) {
          this.retainUnconfirmedDelegation(active, reason);
          return;
        }
        this.activeDelegation = undefined;
        await this.cleanupDelegation(active);
        this.pauseForDelegationFailure(reason);
      })
      .catch((error: unknown) => {
        this.pauseForDelegationFailure(
          error instanceof Error ? error.message : String(error),
        );
      });
  }

  private async finishDelegation(
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ): Promise<void> {
    if (this.activeDelegation !== active) {
      await this.cleanupDelegation(active);
      return;
    }
    this.activeDelegation = undefined;

    try {
      if (
        !this.sessionActive ||
        this.sessionEpoch !== active.sessionEpoch ||
        !this.run ||
        this.run.status !== 'running' ||
        this.run.runId !== active.runId ||
        this.run.currentStepId !== active.stepId ||
        this.run.currentStepDigest !== active.stepDigest
      ) {
        return;
      }
      const workflow = this.catalog.workflows.get(this.run.workflowId);
      const step = workflow?.definition.steps[this.run.currentStepId];
      if (!workflow || !step) {
        throw new Error('Active workflow configuration is unavailable');
      }
      let recoveredTerminalFailure: DelegationFailureDetails | undefined;
      if (response.status !== 'completed') {
        const failure = await delegationFailureDetails(active, response);
        if (failure.diagnostic) {
          active.retryDiagnostic = failure.diagnostic;
        } else {
          delete active.retryDiagnostic;
        }
        if (
          response.status !== 'failed' ||
          failure.diagnostic?.completionAfterFailure !== true
        ) {
          throw new Error(failure.reason);
        }
        const projectionError = recoveredProjectionError(
          active,
          response,
          failure.diagnostic,
        );
        if (projectionError) {
          throw new Error(rejectedRecoveryReason(failure, projectionError));
        }
        recoveredTerminalFailure = failure;
      }
      const requiredSkillWarning =
        step.requires.skills.length > 0
          ? response.warnings?.find((warning) => /skill/i.test(warning))
          : undefined;
      if (requiredSkillWarning) {
        throw new Error(
          `Subagent skill preflight failed: ${requiredSkillWarning}`,
        );
      }

      let serializedResult: string;
      try {
        serializedResult = await readFile(active.policy.resultPath, 'utf8');
      } catch (error) {
        if (recoveredTerminalFailure) {
          throw new Error(
            rejectedRecoveryReason(recoveredTerminalFailure, error),
            { cause: error },
          );
        }
        if (
          (error as { code?: unknown } | null | undefined)?.code === 'ENOENT'
        ) {
          throw new Error(
            `Subagent "${active.agent}" completed without producing the required correlated structured_output result`,
            { cause: error },
          );
        }
        throw error;
      }
      let result: WorkflowStepResult;
      try {
        const rawResult = JSON.parse(serializedResult) as unknown;
        result = parseDelegatedStepResult(rawResult, active.policy);
      } catch (error) {
        if (recoveredTerminalFailure) {
          throw new Error(
            rejectedRecoveryReason(recoveredTerminalFailure, error),
            { cause: error },
          );
        }
        throw error;
      }
      if (
        recoveredTerminalFailure?.diagnostic &&
        !completionMatchesResult(
          recoveredTerminalFailure.diagnostic,
          result,
          active.policy,
        )
      ) {
        throw new Error(
          rejectedRecoveryReason(
            recoveredTerminalFailure,
            'structured_output transcript value does not match the correlated result',
          ),
        );
      }
      if (recoveredTerminalFailure) {
        this.latestContext?.ui.notify(
          `Accepted "${active.stepId}" because the child resolved an earlier tool failure and produced a valid structured result`,
          'warning',
        );
      }
      if (step.gate?.submitOutcome === result.outcome) {
        await this.submitGate(
          workflow,
          this.run,
          result.outcome,
          result.artifact ?? '',
        );
        return;
      }

      this.run = advanceRun(
        workflow,
        this.run,
        result.outcome,
        result.summary,
        Date.now(),
      );
      this.settleAfterTransition(workflow);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!this.retryDelegationAfterToolFailure(active, reason)) {
        this.pauseForDelegationFailure(reason);
      }
    } finally {
      await this.cleanupDelegation(active);
      if (active.cancelling) this.releaseMainAfterCancellation(active);
    }
  }

  private async cancelActiveDelegation(reason: string): Promise<boolean> {
    const active = this.activeDelegation;
    if (!active) return true;
    active.cancelling = true;
    active.progress = 'cancelling';
    this.updateStatus();
    if (this.subagents.activeRequestId !== active.requestId) {
      active.progress = 'cancellation unconfirmed';
      this.updateStatus();
      this.latestContext?.ui.notify(
        `${reason}; the delegation channel already closed without a terminal response`,
        'warning',
      );
      return false;
    }
    const confirmed = await this.subagents.cancelActiveAndWait();
    if (confirmed && this.activeDelegation === active) {
      this.activeDelegation = undefined;
      await this.cleanupDelegation(active);
    } else if (!confirmed) {
      this.latestContext?.ui.notify(
        `${reason}; waiting for subagent "${active.agent}" to confirm termination`,
        'warning',
      );
    }
    return confirmed;
  }

  private async cleanupDelegation(active: ActiveDelegation): Promise<void> {
    await rm(active.resultDirectory, { recursive: true, force: true });
  }

  private retryDelegationAfterToolFailure(
    active: ActiveDelegation,
    reason: string,
  ): boolean {
    if (
      active.toolFailureRetryCount >= MAX_TOOL_FAILURE_RETRIES ||
      !isRetryableToolFailure(reason) ||
      !isSafeToRetryDelegation(
        active.policy,
        active.retryToolFailures,
        active.retryDiagnostic,
      ) ||
      !this.sessionActive ||
      this.sessionEpoch !== active.sessionEpoch ||
      !this.run ||
      this.run.status !== 'running' ||
      this.run.runId !== active.runId ||
      this.run.currentStepId !== active.stepId ||
      this.run.currentStepDigest !== active.stepDigest ||
      this.activeDelegation
    ) {
      return false;
    }
    const workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) return false;

    this.latestContext?.ui.notify(
      `Retrying "${active.stepId}" after a tool failure (${active.toolFailureRetryCount + 1}/${MAX_TOOL_FAILURE_RETRIES})`,
      'warning',
    );
    this.launchCurrentStep(workflow, {
      count: active.toolFailureRetryCount + 1,
      reason,
    });
    return true;
  }

  private pauseForDelegationFailure(reason: string): void {
    this.pauseForExecutionFailure('Subagent step', reason);
  }

  private pauseForExecutionFailure(label: string, reason: string): void {
    if (!this.run || this.run.status !== 'running') return;
    this.mainSteps.deactivate();
    this.run = failRun(this.run, `${label} failed: ${reason}`, Date.now());
    this.persist();
    if (this.activeDelegation) {
      this.isolateMainSessionTools();
    } else {
      this.restoreBaselineTools();
    }
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Workflow paused at "${this.run.currentStepId}": ${reason}`,
      'error',
    );
  }

  private retainUnconfirmedDelegation(
    active: ActiveDelegation,
    reason: string,
  ): void {
    active.cancelling = true;
    active.progress = 'cancellation unconfirmed';
    if (this.run?.status === 'running') {
      this.run = failRun(
        this.run,
        `Subagent step failed: ${reason}`,
        Date.now(),
      );
      this.persist();
    }
    this.isolateMainSessionTools();
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Workflow paused, but subagent "${active.agent}" has not confirmed termination. Main tools and resume remain blocked; restart Pi if no terminal response arrives.`,
      'error',
    );
  }

  private releaseMainAfterCancellation(active: ActiveDelegation): void {
    if (this.activeDelegation === active) this.activeDelegation = undefined;
    if (
      !this.activeDelegation &&
      this.run &&
      this.run.status !== 'running' &&
      this.run.status !== 'awaiting-gate'
    ) {
      this.restoreBaselineTools();
      this.updateStatus();
      this.latestContext?.ui.notify(
        `Subagent "${active.agent}" has terminated; main tools are restored`,
        'info',
      );
    }
  }

  private async submitGate(
    workflow: LoadedWorkflow,
    originalRun: WorkflowRun,
    outcome: string,
    artifact: string,
  ): Promise<void> {
    const requestSessionEpoch = this.sessionEpoch;
    const requestId = `${originalRun.runId}:${originalRun.currentStepId}:${randomUUID()}`;
    const step = workflow.definition.steps[originalRun.currentStepId];
    if (!step?.gate) throw new Error('Current step has no gate');

    const commandShapeError = reviewedCommandShapeError(artifact);
    if (commandShapeError) {
      const awaitingReview = beginGate(
        workflow,
        originalRun,
        outcome,
        artifact,
        requestId,
        Date.now(),
      );
      this.run = resolveGate(
        workflow,
        awaitingReview,
        {
          approved: false,
          feedback: commandShapeError,
          resolvedAt: Date.now(),
        },
        Date.now(),
      );
      this.latestContext?.ui.notify(
        `Plan contract needs repair before review: ${commandShapeError}`,
        'warning',
      );
      this.settleAfterTransition(workflow);
      return;
    }

    this.run = beginGate(
      workflow,
      originalRun,
      outcome,
      artifact,
      requestId,
      Date.now(),
    );
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();

    if (step.gate.provider === 'prompt') {
      this.launchPromptReview(workflow, this.run, this.latestContext);
      return;
    }

    const response = await requestPlannotatorReview(
      this.pi.events,
      requestId,
      artifact,
      `pi-workflows:${workflow.definition.id}:${originalRun.currentStepId}`,
      step.gate.timeoutMs,
    );
    if (
      !this.sessionActive ||
      this.sessionEpoch !== requestSessionEpoch ||
      !this.run ||
      this.run.runId !== originalRun.runId ||
      this.run.currentStepId !== originalRun.currentStepId ||
      this.run.pendingGate?.requestId !== requestId ||
      this.run.pendingGate.reviewId !== undefined
    ) {
      throw new Error('Gate request was superseded by a workflow state change');
    }
    if (
      this.run.status !== 'awaiting-gate' &&
      !(this.run.status === 'paused' && this.run.pendingGate)
    ) {
      throw new Error('Gate request was superseded by a workflow state change');
    }
    if (response.status !== 'handled') {
      const reason = response.error ?? 'Plannotator is unavailable';
      const gateFailed = failGate(this.run, reason, Date.now());
      this.run = failRun(gateFailed, reason, Date.now());
      this.persist();
      if (this.run.status === 'running') {
        this.isolateMainSessionTools();
      } else {
        this.restoreBaselineTools();
      }
      this.updateStatus();
      throw new Error(reason);
    }
    this.run = attachGateReviewId(
      this.run,
      response.result.reviewId,
      Date.now(),
    );
    this.persist();
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Submitted "${originalRun.currentStepId}" for Plannotator review ${response.result.reviewId}`,
      'info',
    );
  }

  private launchPromptReview(
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    context: ExtensionContext | undefined,
  ): void {
    const pendingGate = run.pendingGate;
    if (!pendingGate || pendingGate.provider !== 'prompt') return;
    if (!context?.hasUI) {
      this.pausePromptGate(
        pendingGate.requestId,
        'Built-in review requires Pi TUI or RPC mode; resume there to continue',
        false,
      );
      return;
    }
    if (this.activePromptReview?.requestId === pendingGate.requestId) return;
    this.cancelPromptReview();

    const active: ActivePromptReview = {
      requestId: pendingGate.requestId,
      runId: run.runId,
      stepId: pendingGate.stepId,
      sessionEpoch: this.sessionEpoch,
      abortController: new AbortController(),
    };
    this.activePromptReview = active;
    void requestPromptGateReview(
      context.ui,
      `Review ${workflow.definition.id}:${pendingGate.stepId}`,
      pendingGate.artifact,
      active.abortController.signal,
    ).then(
      (result) => this.queuePromptReviewResult(active, result),
      (error: unknown) =>
        this.queuePromptReviewFailure(
          active,
          error instanceof Error ? error.message : String(error),
        ),
    );
  }

  private queuePromptReviewResult(
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ): void {
    void this.mutationQueue
      .run(() => this.finishPromptReview(active, result))
      .catch((error: unknown) => {
        this.latestContext?.ui.notify(
          `Cannot apply built-in review: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      });
  }

  private queuePromptReviewFailure(
    active: ActivePromptReview,
    reason: string,
  ): void {
    void this.mutationQueue
      .run(async () => {
        if (this.activePromptReview !== active) return;
        this.activePromptReview = undefined;
        this.pausePromptGate(
          active.requestId,
          `Built-in review failed: ${reason}`,
          true,
        );
      })
      .catch((error: unknown) => {
        this.latestContext?.ui.notify(
          `Cannot pause failed built-in review: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      });
  }

  private async finishPromptReview(
    active: ActivePromptReview,
    result: PromptGateReviewResult,
  ): Promise<void> {
    if (this.activePromptReview !== active) return;
    this.activePromptReview = undefined;
    if (
      !this.sessionActive ||
      this.sessionEpoch !== active.sessionEpoch ||
      !this.run ||
      this.run.runId !== active.runId ||
      this.run.currentStepId !== active.stepId ||
      this.run.pendingGate?.provider !== 'prompt' ||
      this.run.pendingGate.requestId !== active.requestId
    ) {
      return;
    }
    if (result.status === 'dismissed') {
      this.pausePromptGate(
        active.requestId,
        'Built-in review was dismissed; resume to reopen it',
        false,
      );
      return;
    }

    const resolution: GateResolution = {
      approved: result.approved,
      feedback: result.feedback,
      resolvedAt: Date.now(),
    };
    if (this.run.status === 'paused') {
      this.run = storeGateResolution(this.run, resolution, Date.now());
      this.persist();
      this.latestContext?.ui.notify(
        'Built-in review finished while paused. Run /workflow-resume to apply it.',
        'info',
      );
      return;
    }
    if (this.run.status !== 'awaiting-gate') return;

    const workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) {
      this.pausePromptGate(
        active.requestId,
        'Built-in review finished, but workflow configuration is unavailable',
        true,
      );
      return;
    }
    try {
      this.run = resolveGate(workflow, this.run, resolution, Date.now());
      this.settleAfterTransition(workflow);
    } catch (error) {
      this.pausePromptGate(
        active.requestId,
        `Cannot apply built-in review: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  private pausePromptGate(
    requestId: string,
    reason: string,
    failed: boolean,
  ): void {
    if (
      !this.run ||
      this.run.pendingGate?.provider !== 'prompt' ||
      this.run.pendingGate.requestId !== requestId
    ) {
      return;
    }
    if (this.run.status === 'awaiting-gate') {
      this.run = failed
        ? failRun(this.run, reason, Date.now())
        : pauseRun(this.run, reason, Date.now());
    }
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Workflow paused at "${this.run.currentStepId}": ${reason}`,
      'warning',
    );
  }

  private cancelPromptReview(): void {
    const active = this.activePromptReview;
    if (!active) return;
    this.activePromptReview = undefined;
    active.abortController.abort();
  }

  private registerPlannotatorResults(): void {
    this.pi.events.on(PLANNOTATOR_RESULT_CHANNEL, (data) => {
      void this.mutationQueue
        .run(() => this.handlePlannotatorResult(data))
        .catch((error: unknown) => {
          this.latestContext?.ui.notify(
            `Cannot apply Plannotator result: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'error',
          );
        });
    });
  }

  private async handlePlannotatorResult(data: unknown): Promise<void> {
    if (
      !this.sessionActive ||
      this.run?.pendingGate?.provider !== 'plannotator' ||
      !this.run.pendingGate.reviewId
    ) {
      return;
    }
    const result = parsePlannotatorResult(data);
    if (!result || result.reviewId !== this.run.pendingGate.reviewId) return;

    const resolution: GateResolution = {
      approved: result.approved,
      feedback: result.feedback,
      resolvedAt: Date.now(),
    };
    if (this.run.status === 'paused') {
      this.run = storeGateResolution(this.run, resolution, Date.now());
      this.persist();
      this.latestContext?.ui.notify(
        `Review ${result.reviewId} finished while paused. Run /workflow-resume to apply it.`,
        'info',
      );
      return;
    }
    if (this.run.status !== 'awaiting-gate') return;

    const workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) {
      this.run = failRun(
        this.run,
        'Gate result arrived, but workflow configuration is unavailable',
        Date.now(),
      );
      this.persist();
      this.restoreBaselineTools();
      this.updateStatus();
      return;
    }
    try {
      this.run = resolveGate(workflow, this.run, resolution, Date.now());
      this.settleAfterTransition(workflow);
    } catch (error) {
      this.run = failRun(
        this.run,
        `Cannot apply gate result: ${error instanceof Error ? error.message : String(error)}`,
        Date.now(),
      );
      this.persist();
      this.restoreBaselineTools();
      this.updateStatus();
    }
  }

  private settleAfterTransition(workflow: LoadedWorkflow): void {
    if (!this.run) return;
    if (this.run.status === 'running') {
      const preflightErrors = this.preflight(workflow, this.run.currentStepId);
      if (preflightErrors.length > 0) {
        this.run = failRun(
          this.run,
          `Step preflight failed: ${preflightErrors.join('; ')}`,
          Date.now(),
        );
      }
    }

    this.persist();
    if (this.run.status !== 'running') {
      this.restoreBaselineTools();
      this.updateStatus();
      if (this.run.status === 'completed') {
        this.latestContext?.ui.notify(
          `Workflow "${this.run.workflowId}" completed`,
          'info',
        );
      } else if (this.run.status === 'paused') {
        this.latestContext?.ui.notify(
          `Workflow paused: ${this.run.pauseReason ?? 'manual action required'}`,
          'warning',
        );
      }
      return;
    }

    this.isolateMainSessionTools();
    this.updateStatus();
    this.launchCurrentStep(workflow);
  }

  private preflight(workflow: LoadedWorkflow, stepId: string): string[] {
    const step = workflow.definition.steps[stepId];
    if (!step) return [`step "${stepId}" does not exist`];
    return preflightStep(step, {
      tools: this.pi.getAllTools(),
      commands: this.pi.getCommands(),
      skills: this.availableSkills,
    });
  }

  private isolateMainSessionTools(): void {
    this.pi.setActiveTools([]);
  }

  private restoreBaselineTools(): void {
    this.mainSteps.release();
    if (this.run) {
      this.pi.setActiveTools(this.run.baselineTools);
      return;
    }
    this.pi.setActiveTools(this.pi.getActiveTools());
  }

  private captureSkills(skills: readonly { name: string }[] | undefined): void {
    if (!skills) return;
    this.availableSkills = new Set(skills.map((skill) => skill.name));
  }

  private enqueueMutation(
    ctx: ExtensionContext,
    operation: (sessionEpoch: number) => Promise<void>,
  ): Promise<void> {
    if (!this.sessionActive) {
      ctx.ui.notify('The Pi session is still initializing', 'warning');
      return Promise.resolve();
    }
    const sessionEpoch = this.sessionEpoch;
    return this.mutationQueue.run(async () => {
      if (!this.sessionActive || this.sessionEpoch !== sessionEpoch) {
        ctx.ui.notify(
          'Workflow command was superseded by a session change',
          'warning',
        );
        return;
      }
      await operation(sessionEpoch);
    });
  }

  private persist(): void {
    if (this.run) {
      this.pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(this.run));
    }
  }

  private restoreFromSession(ctx: ExtensionContext): void {
    this.latestContext = ctx;
    const previousBaseline = this.run?.baselineTools;
    const entries = ctx.sessionManager.getBranch();
    const checkpoint = readLatestCheckpoint(entries, STATE_ENTRY_TYPE);
    this.run = checkpoint.status === 'valid' ? checkpoint.run : undefined;
    if (checkpoint.status === 'invalid') {
      ctx.ui.notify(
        'The newest workflow checkpoint is invalid or from an unsupported version; recovery stopped',
        'error',
      );
    }
    if (
      this.run &&
      (this.run.status === 'running' || this.run.status === 'awaiting-gate')
    ) {
      this.run = pauseRun(
        this.run,
        'Session was restored; inspect the checkpoint before resuming',
        Date.now(),
      );
      this.persist();
    }
    if (!this.run && previousBaseline) {
      this.pi.setActiveTools(previousBaseline);
    } else {
      this.restoreBaselineTools();
    }
    if (this.activeDelegation) this.isolateMainSessionTools();
    this.updateStatus();
  }

  private async reloadCatalog(
    ctx: ExtensionContext,
    announce: boolean,
  ): Promise<boolean> {
    const loadSequence = ++this.catalogLoadSequence;
    const sessionEpoch = this.sessionEpoch;
    const catalog = await loadCatalog({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (
      loadSequence !== this.catalogLoadSequence ||
      sessionEpoch !== this.sessionEpoch
    ) {
      return false;
    }
    this.latestContext = ctx;
    const availableCommands = this.pi.getCommands();
    for (const [workflowId, workflow] of catalog.workflows) {
      const command = workflow.definition.command;
      if (
        hasRuntimeCommandConflict(
          command,
          availableCommands,
          this.registeredWorkflowCommands,
        )
      ) {
        catalog.workflows.delete(workflowId);
        catalog.diagnostics.push({
          level: 'error',
          path: workflow.sourcePath,
          message: `command "/${command}" conflicts with another loaded Pi resource`,
        });
      }
    }
    this.catalog = catalog;
    for (const workflow of catalog.workflows.values()) {
      this.pi.registerCommand(workflow.definition.command, {
        description: workflow.definition.description,
        handler: async (args, commandContext) =>
          this.start(workflow.definition.id, args, commandContext),
      });
      this.registeredWorkflowCommands.add(workflow.definition.command);
    }

    if (announce) {
      const diagnosticText = formatDiagnostics(this.catalog);
      ctx.ui.notify(
        diagnosticText
          ? `Loaded ${this.catalog.workflows.size} workflow(s)\n${diagnosticText}`
          : `Loaded ${this.catalog.workflows.size} workflow(s)`,
        diagnosticText ? 'warning' : 'info',
      );
    } else if (
      this.catalog.diagnostics.some((item) => item.level === 'error')
    ) {
      ctx.ui.notify(
        `Workflow configuration errors:\n${formatDiagnostics(this.catalog)}`,
        'warning',
      );
    }
    return true;
  }

  private updateStatus(): void {
    this.refreshStatusWhileRunning();
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
    if (this.run.status !== 'running') {
      this.latestContext.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    this.latestContext.ui.setStatus(
      STATUS_KEY,
      `${workflowStatusIcon(this.run, snapshot?.now)} ${this.run.workflowId}: working · Ctrl+Alt+W`,
    );
  }

  private refreshStatusWhileRunning(): void {
    if (this.run?.status === 'running' && this.latestContext) {
      if (this.statusRefreshTimer) return;
      this.statusRefreshTimer = setInterval(
        () => this.updateStatus(),
        STATUS_REFRESH_INTERVAL_MS,
      );
      this.statusRefreshTimer.unref?.();
      return;
    }
    this.stopStatusRefresh();
  }

  private stopStatusRefresh(): void {
    if (this.statusRefreshTimer) clearInterval(this.statusRefreshTimer);
    this.statusRefreshTimer = undefined;
  }

  private registerWorkflowStatusShortcut(): void {
    this.pi.registerShortcut(Key.ctrlAlt('w'), {
      description: 'Toggle workflow status',
      handler: async (ctx) => {
        this.latestContext = ctx;
        if (this.statusOverlayOpen) return;
        if (!this.run) {
          ctx.ui.notify('No workflow checkpoint in this session', 'info');
          return;
        }
        await this.showWorkflowStatus(ctx);
      },
    });
  }

  private openWorkflowStatus(ctx: ExtensionContext): void {
    void this.showWorkflowStatus(ctx).catch((error: unknown) => {
      ctx.ui.notify(
        `Cannot open workflow status: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    });
  }

  private async showWorkflowStatus(ctx: ExtensionContext): Promise<void> {
    if (
      this.statusOverlayOpen ||
      !this.run ||
      !ctx.hasUI ||
      ctx.mode !== 'tui'
    ) {
      return;
    }
    this.statusOverlayOpen = true;
    try {
      await showWorkflowStatusOverlay(ctx, () => this.workflowStatusSnapshot());
    } finally {
      this.statusOverlayOpen = false;
    }
  }
}
