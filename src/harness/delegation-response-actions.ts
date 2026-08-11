import {
  parseDelegatedStepResult,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
} from '../integrations/subagents/protocol.ts';
import { advanceRun } from '../engine/transitions.ts';
import {
  attachSubagentTranscript,
  recordCurrentStepResult,
} from '../engine/step-trace.ts';
import type { WorkflowStepResult } from '../runtime/step-result.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import type { ActiveDelegation, DelegationFailureDetails } from './types.ts';
import { resolveStepEffects } from './step-effects.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'catalog'
  | 'cleanupDelegation'
  | 'delegationFailures'
  | 'dependencies'
  | 'finishDelegation'
  | 'isSessionActive'
  | 'latestContext'
  | 'mutationQueue'
  | 'pauseForDelegationFailure'
  | 'releaseMainAfterCancellation'
  | 'retainUnconfirmedDelegation'
  | 'retryDelegationAfterFailure'
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
    update.currentTool ? `tool ${update.currentTool}` : undefined,
    update.toolCount !== undefined ? `${update.toolCount} calls` : undefined,
    update.tokens !== undefined ? `${update.tokens} tokens` : undefined,
  ].filter((part): part is string => part !== undefined);
  active.progress = progress.join(', ') || 'running';
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
  let terminalFailure: DelegationFailureDetails | undefined;
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
    if (
      response.requestId === active.requestId &&
      (response.agent === undefined || response.agent === active.agent) &&
      response.sessionFile &&
      active.trustedSessionRoot &&
      typeof response.runId === 'string' &&
      response.runId &&
      response.childIndex === 0
    ) {
      try {
        this.run = attachSubagentTranscript(
          this.run,
          active.requestId,
          {
            trustedRoot: active.trustedSessionRoot,
            sessionFile: response.sessionFile,
            runId: response.runId,
            childIndex: response.childIndex,
          },
          terminalAt,
        );
      } catch {
        // Status evidence is best-effort and cannot alter terminal handling.
      }
    }
    const workflow = this.catalog.workflows.get(this.run.workflowId);
    const step = workflow?.definition.steps[this.run.currentStepId];
    if (!workflow || !step) {
      throw new Error('Active workflow configuration is unavailable');
    }
    if (response.status === 'completed' && !active.directWorker) {
      const transcriptAudit =
        await this.delegationFailures.completedResponseAudit(active, response);
      if (!transcriptAudit.verified) {
        throw new Error(
          `Subagent "${active.agent}" completed without a verifiable terminal transcript: ${transcriptAudit.reason}`,
        );
      }
      if (transcriptAudit.warning) {
        throw new Error(
          `Subagent "${active.agent}" completed with an unresolved post-completion watchdog warning: ${transcriptAudit.warning}`,
        );
      }
    }
    let recoveredTerminalFailure: DelegationFailureDetails | undefined;
    if (
      response.status !== 'completed' ||
      this.delegationFailures.hasContradictoryCompletion(response)
    ) {
      const failure = await this.delegationFailures.describeDelegationFailure(
        active,
        response,
      );
      terminalFailure = failure;
      if (
        response.status !== 'failed' ||
        failure.diagnostic?.completionAfterFailure !== true
      ) {
        throw new Error(failure.reason);
      }
      const projectionError = this.delegationFailures.recoveredProjectionError(
        active,
        response,
        failure.diagnostic,
      );
      if (projectionError) {
        throw new Error(
          this.delegationFailures.rejectedRecoveryReason(
            failure,
            projectionError,
          ),
        );
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
      serializedResult = await this.dependencies.readDelegatedResult(active);
    } catch (error) {
      if (recoveredTerminalFailure) {
        throw new Error(
          this.delegationFailures.rejectedRecoveryReason(
            recoveredTerminalFailure,
            error,
          ),
          { cause: error },
        );
      }
      if (hasErrorCode(error, 'ENOENT')) {
        throw new Error(
          `Subagent "${active.agent}" completed without producing the required correlated structured_output result`,
          { cause: error },
        );
      }
      throw error;
    }

    let result: WorkflowStepResult;
    try {
      const rawResult: unknown = JSON.parse(serializedResult);
      result = parseDelegatedStepResult(rawResult, active.policy);
    } catch (error) {
      if (recoveredTerminalFailure) {
        throw new Error(
          this.delegationFailures.rejectedRecoveryReason(
            recoveredTerminalFailure,
            error,
          ),
          { cause: error },
        );
      }
      throw error;
    }
    if (
      recoveredTerminalFailure?.diagnostic &&
      !this.delegationFailures.completionMatchesResult(
        recoveredTerminalFailure.diagnostic,
        result,
        active.policy,
      )
    ) {
      throw new Error(
        this.delegationFailures.rejectedRecoveryReason(
          recoveredTerminalFailure,
          'structured_output transcript value does not match the correlated result',
        ),
      );
    }
    const acceptedAt = terminalAt;
    if (recoveredTerminalFailure) {
      const isFalsePositive =
        recoveredTerminalFailure.diagnostic?.correlation ===
        'successful-output-before-completion';
      this.latestContext?.ui.notify(
        isFalsePositive
          ? `Accepted "${active.stepId}" because the trusted child transcript proved the terminal tool error was a false positive and produced a matching structured result`
          : `Accepted "${active.stepId}" because the child resolved an earlier tool failure and produced a valid structured result`,
        'warning',
      );
    }
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
    if (!this.retryDelegationAfterFailure(active, terminalFailure, reason)) {
      const failureSummary = terminalFailure?.error
        ? `Subagent ${terminalFailure.status.replaceAll('_', ' ')}: ${terminalFailure.error}`
        : terminalFailure
          ? `Subagent ${terminalFailure.status.replaceAll('_', ' ')}`
          : reason;
      this.pauseForDelegationFailure(reason, failureSummary);
    }
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
