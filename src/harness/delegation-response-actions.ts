import {
  parseDelegatedStepResult,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from '../integrations/subagents/protocol.ts';
import { advanceRun } from '../engine/transitions.ts';
import { recordCurrentStepResult } from '../engine/step-trace.ts';
import type { WorkflowStepResult } from '../runtime/step-result.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import type { ActiveDelegation } from './types.ts';
import { resolveStepEffects } from './step-effects.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'catalog'
  | 'cleanupDelegation'
  | 'dependencies'
  | 'finishDelegation'
  | 'isSessionActive'
  | 'latestContext'
  | 'mutationQueue'
  | 'pauseForDelegationFailure'
  | 'releaseMainAfterCancellation'
  | 'retainUnconfirmedDelegation'
  | 'run'
  | 'sessionEpoch'
  | 'settleAfterTransition'
  | 'subagents'
  | 'submitGate'
  | 'updateStatus'
>;

export type DelegationResponseActions = {
  handleDelegationUpdate: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    update: SubagentDelegationUpdate,
  ) => void;
  queueDelegationResponse: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => void;
  queueDelegationFailure: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    reason: string,
  ) => void;
  finishDelegation: (
    this: HarnessActionContext,
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => Promise<void>;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function handleDelegationUpdate(
  this: HarnessActionContext,
  active: ActiveDelegation,
  update: SubagentDelegationUpdate,
): void {
  if (this.activeDelegation !== active) return;
  const progress = [
    update.activity,
    update.currentTool ? `tool ${update.currentTool}` : undefined,
    update.toolCount !== undefined ? `${update.toolCount} calls` : undefined,
    update.tokens !== undefined ? `${update.tokens} tokens` : undefined,
  ].filter((part): part is string => part !== undefined);
  active.progress = progress.join(', ') || 'running';
  if (update.detail) {
    const previous = active.activityLog ?? [];
    const replacesPreviousResponse =
      update.detail.startsWith('response: ') &&
      previous.at(-1)?.startsWith('response: ');
    active.activityLog = [
      ...(replacesPreviousResponse ? previous.slice(0, -1) : previous),
      update.detail,
    ].slice(-8);
  }
  this.updateStatus();
}

function queueDelegationResponse(
  this: HarnessActionContext,
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

function queueDelegationFailure(
  this: HarnessActionContext,
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

async function finishDelegation(
  this: HarnessActionContext,
  active: ActiveDelegation,
  response: SubagentDelegationResponse,
): Promise<void> {
  if (this.activeDelegation !== active) {
    await this.cleanupDelegation(active);
    return;
  }
  this.activeDelegation = undefined;
  let cleanupAttempted = false;

  try {
    if (
      !this.isSessionActive ||
      this.sessionEpoch !== active.sessionEpoch ||
      !this.run ||
      this.run.status !== 'running' ||
      this.run.runId !== active.runId ||
      this.run.currentStepId !== active.stepId ||
      this.run.currentStepDigest !== active.stepDigest
    ) {
      return;
    }
    const terminalAt = this.dependencies.now();
    const workflow = this.catalog.workflows.get(this.run.workflowId);
    const step = workflow?.definition.steps[this.run.currentStepId];
    if (!workflow || !step) {
      throw new Error('Active workflow configuration is unavailable');
    }
    if (response.status !== 'completed') {
      throw new Error(
        `Workflow worker "${active.agent}" ${response.status.replaceAll('_', ' ')}${response.error ? `: ${response.error}` : ''}`,
      );
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
      serializedResult = await this.dependencies.readDelegatedResult(active);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new Error(
          `Subagent "${active.agent}" completed without producing the required correlated structured_output result`,
          { cause: error },
        );
      }
      throw error;
    }

    const rawResult: unknown = JSON.parse(serializedResult);
    const result: WorkflowStepResult = parseDelegatedStepResult(
      rawResult,
      active.policy,
    );
    const acceptedAt = terminalAt;
    if (step.gate?.submitOutcome === result.outcome) {
      this.run = recordCurrentStepResult(this.run, result, acceptedAt);
      await this.submitGate(
        workflow,
        this.run,
        result.outcome,
        result.summary,
        result.artifact ?? '',
      );
      return;
    }

    const effects = resolveStepEffects(
      this.run,
      step,
      result,
      this.dependencies,
    );
    const tracedRun = recordCurrentStepResult(
      this.run,
      result,
      acceptedAt,
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
      stepId: active.stepId,
      outcome: result.outcome,
      summary: result.summary,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    cleanupAttempted = true;
    await this.cleanupDelegation(active);
    this.pauseForDelegationFailure(reason);
  } finally {
    try {
      if (!cleanupAttempted) await this.cleanupDelegation(active);
    } finally {
      if (active.cancelling) this.releaseMainAfterCancellation(active);
    }
  }
}

/**
 * Returns delegation response and result-processing actions for composition.
 */
export function createDelegationResponseActions(): DelegationResponseActions {
  return {
    handleDelegationUpdate,
    queueDelegationResponse,
    queueDelegationFailure,
    finishDelegation,
  };
}
