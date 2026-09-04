import type { DelegationDiagnostic } from '../../domain/index.ts';
import { classifyRecoverySafety } from '../../function/index.ts';

/**
 * Allows one fresh retry only after the same-child repair settled with complete
 * read-only evidence. The caller owns preserving run identity and cleanup.
 */
export const shouldRetryMissingCompletion = (
  diagnostic: DelegationDiagnostic | undefined,
  subagentAttemptCount: number,
): boolean =>
  subagentAttemptCount === 1 &&
  classifyRecoverySafety(diagnostic) === 'read-only';
