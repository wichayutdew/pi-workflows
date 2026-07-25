import type { WorkflowStepResult } from '../runtime/step-result.ts';
import {
  failedToolName,
  formatToolFailureDiagnostic,
} from '../integrations/subagents/diagnostics.ts';
import type {
  ChildStepPolicy,
  SubagentDelegationResponse,
} from '../integrations/subagents/protocol.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';
import {
  completionMatchesResult,
  recoveredProjectionError,
} from './delegation-recovery-validation.ts';
import {
  boundedFailureField,
  delegationFailureFingerprint,
  isRetryableTerminalFailure,
  isSafeToRetryDelegation,
  rejectedRecoveryReason,
} from './delegation-retry-policy.ts';
import type {
  ActiveDelegation,
  DelegationFailureDetails,
  DelegationRecoveryBlocker,
} from './types.ts';

export type DelegationFailureActions = {
  delegationFailureFingerprint: (failure: DelegationFailureDetails) => string;
  hasContradictoryCompletion: (response: SubagentDelegationResponse) => boolean;
  isRetryableTerminalFailure: (failure: DelegationFailureDetails) => boolean;
  isSafeToRetryDelegation: (
    policy: ChildStepPolicy,
    isReplayExplicitlyAuthorized: boolean,
    replayAudit: DelegationFailureDetails['replayAudit'],
  ) => boolean;
  rejectedRecoveryReason: (
    failure: DelegationFailureDetails,
    error: unknown,
  ) => string;
  completionMatchesResult: (
    diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
    result: WorkflowStepResult,
    policy: ChildStepPolicy,
  ) => boolean;
  recoveredProjectionError: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
    diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
  ) => string | undefined;
  describeDelegationFailure: (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ) => Promise<DelegationFailureDetails>;
};

function nonEmptyTerminalError(
  response: SubagentDelegationResponse,
): string | undefined {
  return [response.error, response.execution?.error].find(
    (error): error is string =>
      typeof error === 'string' && error.trim().length > 0,
  );
}

function nonzeroTerminalExitCode(
  response: SubagentDelegationResponse,
): number | undefined {
  return [response.exitCode, response.execution?.exitCode].find(
    (exitCode): exitCode is number =>
      typeof exitCode === 'number' &&
      Number.isSafeInteger(exitCode) &&
      exitCode !== 0,
  );
}

function hasContradictoryCompletion(
  response: SubagentDelegationResponse,
): boolean {
  return (
    response.status === 'completed' &&
    (nonEmptyTerminalError(response) !== undefined ||
      nonzeroTerminalExitCode(response) !== undefined)
  );
}

function recoveryBlocker(
  response: SubagentDelegationResponse,
): DelegationRecoveryBlocker | undefined {
  const execution = response.execution;
  const fileMutation = response.effects?.fileMutation;
  if (fileMutation?.attempted === true || fileMutation?.status === 'observed') {
    return 'reported-mutation';
  }
  if (execution?.detached === true || execution?.status === 'detached') {
    return 'detached';
  }
  if (execution?.stopped === true || execution?.status === 'stopped') {
    return 'stopped';
  }
  if (
    response.status === 'interrupted' ||
    execution?.interrupted === true ||
    execution?.status === 'paused'
  ) {
    return 'interrupted';
  }
  if (response.status === 'cancelled') return 'cancelled';
  if (execution?.timedOut === true && response.status !== 'timed_out') {
    return 'inconsistent-timeout';
  }
  return undefined;
}

function validateReplayAudit(
  response: SubagentDelegationResponse,
  replayAudit: DelegationFailureDetails['replayAudit'],
): DelegationFailureDetails['replayAudit'] {
  if (!replayAudit) return undefined;
  if (
    response.toolCount !== undefined &&
    response.toolCount !== replayAudit.toolCount
  ) {
    return { ...replayAudit, replaySafe: false };
  }
  return replayAudit;
}

/**
 * Creates pure delegation-failure evaluators plus the injected diagnostic
 * reader used at the transcript I/O boundary.
 */
export function createDelegationFailureActions(
  dependencies: Pick<
    WorkflowHarnessDependencies,
    'readDelegationReplayAudit' | 'readToolFailureDiagnostic'
  >,
): DelegationFailureActions {
  const describeDelegationFailure = async (
    active: ActiveDelegation,
    response: SubagentDelegationResponse,
  ): Promise<DelegationFailureDetails> => {
    const blocker = recoveryBlocker(response);
    const terminalError = nonEmptyTerminalError(response);
    const error =
      terminalError ?? 'The subagent returned no terminal error details.';
    const isResponseIdentityValid =
      response.childIndex === 0 &&
      (response.agent === undefined || response.agent === active.agent);
    const identity =
      isResponseIdentityValid && response.runId !== undefined
        ? { runId: response.runId, childIndex: 0 }
        : undefined;
    const [diagnostic, replayAudit] = await Promise.all([
      dependencies.readToolFailureDiagnostic(
        response.sessionFile,
        active.trustedSessionRoot,
        identity,
        failedToolName(terminalError),
        terminalError,
      ),
      dependencies.readDelegationReplayAudit(
        response.sessionFile,
        active.trustedSessionRoot,
        identity,
        {
          task: active.transcriptTask,
          bashPermission: active.policy.permissions.bash,
          approvedBashCommands: active.policy.approvedBashCommands ?? [],
        },
      ),
    ]);
    const validatedReplayAudit = validateReplayAudit(response, replayAudit);
    const exitCode =
      nonzeroTerminalExitCode(response) ??
      response.exitCode ??
      response.execution?.exitCode;
    const reason = [
      hasContradictoryCompletion(response)
        ? `Subagent "${active.agent}" reported terminal failure signals with completed status.`
        : `Subagent "${active.agent}" ${response.status.replaceAll('_', ' ')}.`,
      ...(diagnostic ? formatToolFailureDiagnostic(diagnostic) : []),
      ...(exitCode !== undefined ? [`Subagent exit code: ${exitCode}`] : []),
      ...(blocker
        ? [`Automatic recovery blocked by: ${blocker.replaceAll('-', ' ')}`]
        : []),
      `Terminal error: ${boundedFailureField(error)}`,
      ...(diagnostic && response.sessionFile
        ? [
            `Diagnostic session: ${boundedFailureField(response.sessionFile.replaceAll(/\s+/g, ' '))}`,
          ]
        : []),
    ].join('\n');
    return {
      reason,
      status: response.status,
      ...(terminalError ? { error: terminalError } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(blocker ? { recoveryBlocker: blocker } : {}),
      ...(diagnostic ? { diagnostic } : {}),
      ...(validatedReplayAudit ? { replayAudit: validatedReplayAudit } : {}),
    };
  };

  return {
    delegationFailureFingerprint,
    hasContradictoryCompletion,
    isRetryableTerminalFailure,
    isSafeToRetryDelegation,
    rejectedRecoveryReason,
    completionMatchesResult,
    recoveredProjectionError,
    describeDelegationFailure,
  };
}
