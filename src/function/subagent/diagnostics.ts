export type {
  DelegationDiagnostic,
  DelegationDiagnosticCall,
  DiagnosticCallState,
  RecoverySafety,
} from '../../domain/index.ts';
import type {
  DelegationDiagnostic,
  RecoverySafety,
} from '../../domain/index.ts';

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'ls',
  'grep',
  'structured_output',
]);

/**
 * Decides whether a fresh child may safely repeat a step after same-child
 * completion repair failed. Unknown, partial, and mutation-capable evidence
 * always fails closed.
 */
export const classifyRecoverySafety = (
  diagnostic: DelegationDiagnostic | undefined,
): RecoverySafety => {
  if (!diagnostic || !diagnostic.settled || diagnostic.truncated) {
    return 'incomplete';
  }
  if (
    diagnostic.calls.some(
      (call) => call.state !== 'completed' || !READ_ONLY_TOOLS.has(call.name),
    )
  ) {
    return 'unsafe';
  }
  return 'read-only';
};
