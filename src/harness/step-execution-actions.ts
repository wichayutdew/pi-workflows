import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { advanceRun, allowedOutcomes } from '../engine/transitions.ts';
import { digest } from '../digest.ts';
import type { SubagentDelegationResponse } from '../integrations/subagents/protocol.ts';
import { buildMainStepTask } from '../prompt.ts';
import { narrowApprovedBashCommands } from '../policy/approved-commands.ts';
import type { MainStepExecution } from '../runtime/main-step-runtime.ts';
import type { WorkflowStepResult } from '../runtime/step-result.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { createDelegationPlan } from './delegation-plan.ts';
import type { DelegationRecovery, MainStepIdentity } from './types.ts';

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
  | 'pi'
  | 'queueDelegationFailure'
  | 'queueDelegationResponse'
  | 'queueMainStepResult'
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
    recovery?: DelegationRecovery,
  ) => void;
  launchMainStep: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    run: WorkflowRun,
    step: WorkflowStep,
  ) => void;
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
  recovery?: DelegationRecovery,
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
  if (!step.subagent) {
    this.launchMainStep(workflow, run, step);
    return;
  }

  const plan = createDelegationPlan(
    {
      workflow,
      run,
      step,
      sessionEpoch: this.sessionEpoch,
      latestContext: this.latestContext,
      recovery,
    },
    this.dependencies,
  );
  if (plan.kind === 'invalid') {
    this.pauseForExecutionFailure('Subagent step', plan.reason);
    return;
  }
  const { active, request } = plan;

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
    nonce: this.dependencies.createRequestId(),
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
  this.latestContext = context;
  if (
    !this.isSessionActive ||
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
    this.dependencies.now(),
  );
  this.settleAfterTransition(workflow);
}

/**
 * Returns main and delegated step-launch actions for harness composition.
 */
export function createStepExecutionActions(): StepExecutionActions {
  return {
    launchCurrentStep,
    launchMainStep,
    queueMainStepResult,
    finishMainStep,
  };
}
