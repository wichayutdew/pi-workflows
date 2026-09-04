import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  LoadedWorkflow,
  SubagentDelegationResponse,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepResult,
} from '../../domain/index.ts';
import {
  advanceRun,
  allowedOutcomes,
  appendMainStepLog,
  beginMainStepAttempt,
  beginSubagentStepAttempt,
  buildMainStepTask,
  digest,
  recordCurrentStepResult,
  recordCurrentStepUsage,
  usageAggregateFromModels,
} from '../../function/index.ts';
import type { ModelUsage } from '../../function/index.ts';
import type { MainStepExecution } from '../runtime/main-step-runtime.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { createDelegationPlan } from './delegation-plan.ts';
import type { MainStepIdentity } from './types.ts';
import { resolveStepEffects } from './step-effects.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'catalog'
  | 'dependencies'
  | 'finishMainStep'
  | 'handleDelegationUpdate'
  | 'isSessionActive'
  | 'latestContext'
  | 'launchMainStep'
  | 'mainSteps'
  | 'mutationQueue'
  | 'pauseForExecutionFailure'
  | 'persist'
  | 'pi'
  | 'queueDelegationFailure'
  | 'queueDelegationResponse'
  | 'queueMainStepLog'
  | 'queueMainStepResult'
  | 'recordMainStepLog'
  | 'run'
  | 'sessionEpoch'
  | 'settleAfterTransition'
  | 'subagents'
  | 'submitGate'
  | 'updateStatus'
>;

export type StepExecutionActions = {
  launchCurrentStep: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
  ) => void;
  launchMainStep: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    step: WorkflowStep,
  ) => void;
  queueMainStepLog: (
    this: HarnessActionContext,
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
    usage?: ReadonlyArray<ModelUsage>,
  ) => Promise<void>;
  recordMainStepLog: (
    this: HarnessActionContext,
    identity: MainStepIdentity,
    lines: ReadonlyArray<string>,
    context: ExtensionContext,
    usage?: ReadonlyArray<ModelUsage>,
  ) => Promise<void>;
  queueMainStepResult: (
    this: HarnessActionContext,
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void>;
  finishMainStep: (
    this: HarnessActionContext,
    identity: MainStepIdentity,
    result: WorkflowStepResult | undefined,
    context: ExtensionContext,
  ) => Promise<void>;
};

function launchCurrentStep(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
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
  const plan = createDelegationPlan(
    {
      workflow,
      run,
      step,
      sessionEpoch: this.sessionEpoch,
      latestContext: this.latestContext,
    },
    this.dependencies,
  );
  if (plan.kind === 'invalid') {
    this.pauseForExecutionFailure('Subagent step', plan.reason);
    return;
  }
  const { active, request } = plan;

  try {
    this.run = beginSubagentStepAttempt(
      run,
      active.requestId,
      active.agent,
      active.transcriptTask,
      this.dependencies.now(),
    );
    this.persist();
  } catch {
    // Status evidence is best-effort and must never block step execution.
  }
  this.activeDelegation = active;
  this.updateStatus();
  this.latestContext?.ui.notify(
    `Delegated "${run.currentStepId}" to subagent "${active.agent}"`,
    'info',
  );
  let delegation: Promise<SubagentDelegationResponse>;
  try {
    delegation = this.subagents.delegate(request, {
      onUpdate: (update) => {
        this.handleDelegationUpdate(active, update);
      },
      onLateTerminal: (response) => {
        this.queueDelegationResponse(active, response);
      },
    });
  } catch (error) {
    this.queueDelegationFailure(
      active,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  void delegation.then(
    (response) => {
      this.queueDelegationResponse(active, response);
    },
    (error: unknown) => {
      this.queueDelegationFailure(
        active,
        error instanceof Error ? error.message : String(error),
      );
    },
  );
}

function launchMainStep(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  step: WorkflowStep,
): void {
  const actualCwd = this.latestContext?.cwd;
  if (!run.cwd || !actualCwd) {
    this.pauseForExecutionFailure(
      'Main-agent step',
      'Workflow working directory is unavailable; abort it and start a new run',
    );
    return;
  }
  try {
    const expectedCanonicalCwd = this.dependencies.resolveWorkspaceDirectory({
      candidateCwd: run.cwd,
      startCwd: run.cwd,
      allowedRoots: ['.'],
    });
    const actualCanonicalCwd = this.dependencies.resolveWorkspaceDirectory({
      candidateCwd: actualCwd,
      startCwd: actualCwd,
      allowedRoots: ['.'],
    });
    if (actualCanonicalCwd !== expectedCanonicalCwd) {
      throw new Error(
        `current session cwd "${actualCwd}" does not match captured workflow cwd "${run.cwd}"`,
      );
    }
  } catch (error) {
    this.pauseForExecutionFailure(
      'Main-agent step',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const policyDigest = digest({
    version: 1,
    execution: 'main',
    workflowId: workflow.definition.id,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    permissions: step.permissions,
    nonce: this.dependencies.createRequestId(),
  });
  const task = buildMainStepTask(workflow, run);
  const identity: MainStepIdentity = {
    requestId: policyDigest,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    sessionEpoch: this.sessionEpoch,
  };
  const execution: MainStepExecution = {
    workflowId: workflow.definition.id,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    policyDigest,
    task,
    step: structuredClone(step),
    outcomes: allowedOutcomes(workflow, run),
    summaryMaxChars: workflow.definition.summaryMaxChars,
    ...(step.gate ? { gateSubmitOutcome: step.gate.submitOutcome } : {}),
    ...(step.workspace ? { workspace: structuredClone(step.workspace) } : {}),
    onTrace: (lines, context, usage) =>
      this.queueMainStepLog(identity, lines, context, usage),
    onSettled: (result, context) =>
      this.queueMainStepResult(identity, result, context),
  };

  try {
    try {
      this.run = beginMainStepAttempt(
        run,
        policyDigest,
        task,
        this.dependencies.now(),
      );
      this.persist();
    } catch {
      // Status evidence is best-effort and must never block step execution.
    }
    this.mainSteps.activate(execution);
    this.updateStatus();
    this.latestContext?.ui.notify(
      `Started "${run.currentStepId}" in the main agent`,
      'info',
    );
    this.pi.sendUserMessage(task, {
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

function hasCurrentMainStepIdentity(
  context: HarnessActionContext,
  identity: MainStepIdentity,
): context is HarnessActionContext & { run: WorkflowRun } {
  return (
    context.isSessionActive &&
    context.sessionEpoch === identity.sessionEpoch &&
    context.run?.status === 'running' &&
    context.run.runId === identity.runId &&
    context.run.currentStepId === identity.stepId &&
    context.run.currentStepDigest === identity.stepDigest
  );
}

function matchesLatestMainStepAttempt(
  run: WorkflowRun,
  identity: MainStepIdentity,
): boolean {
  const attempt = run.currentStepAttempts?.at(-1);
  return (
    attempt === undefined ||
    (attempt.kind === 'main' && attempt.requestId === identity.requestId)
  );
}

function queueMainStepLog(
  this: HarnessActionContext,
  identity: MainStepIdentity,
  lines: ReadonlyArray<string>,
  context: ExtensionContext,
  usage?: ReadonlyArray<ModelUsage>,
): Promise<void> {
  return this.mutationQueue
    .run(() => this.recordMainStepLog(identity, lines, context, usage))
    .catch(() => {
      // Status evidence is best-effort and must never pause step execution.
    });
}

async function recordMainStepLog(
  this: HarnessActionContext,
  identity: MainStepIdentity,
  lines: ReadonlyArray<string>,
  context: ExtensionContext,
  usage?: ReadonlyArray<ModelUsage>,
): Promise<void> {
  if (
    !hasCurrentMainStepIdentity(this, identity) ||
    !matchesLatestMainStepAttempt(this.run, identity)
  ) {
    return;
  }
  const attempt = this.run.currentStepAttempts?.at(-1);
  if (attempt?.kind !== 'main' || attempt.requestId !== identity.requestId) {
    return;
  }
  this.latestContext = context;
  let traced = appendMainStepLog(
    this.run,
    identity.requestId,
    lines,
    this.dependencies.now(),
  );
  if (usage && usage.length > 0) {
    traced = recordCurrentStepUsage(
      traced,
      identity.requestId,
      usageAggregateFromModels(usage),
      this.dependencies.now(),
    );
  }
  if (traced === this.run) return;
  this.run = traced;
  this.persist();
  this.updateStatus();
}

function queueMainStepResult(
  this: HarnessActionContext,
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

async function finishMainStep(
  this: HarnessActionContext,
  identity: MainStepIdentity,
  result: WorkflowStepResult | undefined,
  context: ExtensionContext,
): Promise<void> {
  if (
    !hasCurrentMainStepIdentity(this, identity) ||
    !matchesLatestMainStepAttempt(this.run, identity)
  ) {
    return;
  }
  this.latestContext = context;
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
    this.run = recordCurrentStepResult(
      this.run,
      result,
      this.dependencies.now(),
    );
    await this.submitGate(
      workflow,
      this.run,
      result.outcome,
      result.summary,
      result.artifact ?? '',
    );
    return;
  }

  const effects = resolveStepEffects(this.run, step, result, this.dependencies);
  const tracedRun = recordCurrentStepResult(
    this.run,
    result,
    this.dependencies.now(),
    effects.workspaceCwd,
  );
  this.run = advanceRun(
    workflow,
    tracedRun,
    result.outcome,
    result.summary,
    this.dependencies.now(),
    effects,
  );
  this.settleAfterTransition(workflow, {
    stepId: identity.stepId,
    outcome: result.outcome,
    summary: result.summary,
  });
}

/**
 * Returns main and delegated step-launch actions for harness composition.
 */
export function createStepExecutionActions(): StepExecutionActions {
  return {
    launchCurrentStep,
    launchMainStep,
    queueMainStepLog,
    recordMainStepLog,
    queueMainStepResult,
    finishMainStep,
  };
}
