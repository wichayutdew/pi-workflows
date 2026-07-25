import { digest } from '../digest.ts';
import type { ChildStepPolicy } from '../integrations/subagents/protocol.ts';
import type { DelegationFailureDetails } from './types.ts';

const MAX_FAILURE_FIELD_CHARS = 1_600;
export const MAX_DELEGATION_RECOVERY_ATTEMPTS = 2;

const normalizedFingerprintField = (
  value: string | undefined,
): string | undefined => value?.trim().replaceAll(/\s+/g, ' ') || undefined;

/**
 * Creates a stable identity for the semantic evidence behind one failure.
 *
 * Runtime request identifiers and session paths are deliberately absent so a
 * fresh child repeating the same failed approach is recognized.
 *
 * @param failure - Normalized terminal failure evidence.
 * @returns Stable digest used to stop duplicate automatic recovery attempts.
 */
export function delegationFailureFingerprint(
  failure: DelegationFailureDetails,
): string {
  return digest({
    status: failure.status,
    exitCode: failure.exitCode,
    error: normalizedFingerprintField(failure.error),
    recoveryBlocker: failure.recoveryBlocker,
    replayToolCount: failure.replayAudit?.toolCount,
    diagnostic: failure.diagnostic
      ? {
          tool: normalizedFingerprintField(failure.diagnostic.tool),
          call: normalizedFingerprintField(failure.diagnostic.call),
          output: normalizedFingerprintField(failure.diagnostic.output),
        }
      : undefined,
  });
}

/**
 * Bounds a failure field while retaining evidence from both ends.
 *
 * @param value - Untrusted diagnostic text.
 * @returns Text safe for inclusion in a workflow notification.
 */
export function boundedFailureField(value: string): string {
  if (value.length <= MAX_FAILURE_FIELD_CHARS) return value;
  const marker = '… [truncated] …';
  const available = MAX_FAILURE_FIELD_CHARS - marker.length - 2;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}\n${marker}\n${value.slice(-endLength)}`;
}

/**
 * Returns whether a terminal failure contains evidence suitable for recovery.
 *
 * @param failure - Normalized terminal failure.
 * @returns Whether diagnostic recovery may be attempted.
 */
export function isRetryableTerminalFailure(
  failure: DelegationFailureDetails,
): boolean {
  if (failure.recoveryBlocker !== undefined) return false;
  if (
    failure.status === 'timed_out' ||
    failure.status === 'turn_budget_exhausted' ||
    failure.status === 'tool_budget_exhausted'
  ) {
    return true;
  }
  if (
    failure.status !== 'failed' &&
    failure.status !== 'structured_output_failed'
  ) {
    return false;
  }
  return (
    failure.error !== undefined ||
    (Number.isSafeInteger(failure.exitCode) && failure.exitCode !== 0)
  );
}

/**
 * Applies replay-safety policy to a proposed delegation retry.
 *
 * @param policy - Child policy from the failed delegation.
 * @param isReplayExplicitlyAuthorized - Workflow-level retry authorization.
 * @param replayAudit - Transcript-derived replay evidence.
 * @returns Whether retrying the delegation is safe.
 */
export function isSafeToRetryDelegation(
  policy: ChildStepPolicy,
  isReplayExplicitlyAuthorized: boolean,
  replayAudit: DelegationFailureDetails['replayAudit'],
): boolean {
  return (
    replayAudit?.replaySafe === true &&
    (isReplayExplicitlyAuthorized ||
      policy.permissions.bash.mode === 'deny' ||
      policy.permissions.bash.mode === 'read-only')
  );
}

/**
 * Extends a failure reason with bounded recovery-rejection evidence.
 *
 * @param failure - Original normalized failure.
 * @param error - Error raised while attempting recovery.
 * @returns User-facing rejection reason.
 */
export function rejectedRecoveryReason(
  failure: DelegationFailureDetails,
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${failure.reason}\nRecovery rejected: ${boundedFailureField(detail)}`;
}
