import type { BashPermission } from '../../config/types.ts';
import { authorizeBash } from '../../policy/bash.ts';
import type {
  RecordedToolCall,
  RecordedToolFailure,
} from './diagnostic-types.ts';

const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'find',
  'grep',
  'ls',
  'read',
  'structured_output',
]);

const isPreExecutionBashFailure = (
  output: string | undefined,
  rejectionReason: string | undefined,
): boolean =>
  Boolean(
    output &&
    rejectionReason &&
    output.toLowerCase().includes(rejectionReason.toLowerCase()),
  );

/**
 * Returns whether replaying a recorded call cannot repeat a mutation.
 */
export const isReplaySafeToolCall = ({
  call,
  diagnostics,
  bashPermission,
}: {
  readonly call: RecordedToolCall;
  readonly diagnostics: ReadonlyArray<RecordedToolFailure>;
  readonly bashPermission?: BashPermission;
}): boolean => {
  const tool = call.tool.toLowerCase();
  if (REPLAY_SAFE_TOOLS.has(tool)) return true;
  if (tool !== 'bash' || !call.call) return false;
  if (!bashPermission) {
    return false;
  }
  const authorization = authorizeBash(call.call, bashPermission);
  if (authorization.allowed) return false;
  const failure = diagnostics.find(
    (diagnostic) => diagnostic.callId === call.id,
  );
  return isPreExecutionBashFailure(failure?.output, authorization.reason);
};

/**
 * Returns whether a complete failure transcript contains only replay-safe
 * calls.
 */
export const isFailureTranscriptReplaySafe = ({
  calls,
  diagnostics,
  isCompleteTranscript,
}: {
  readonly calls: ReadonlyArray<RecordedToolCall>;
  readonly diagnostics: ReadonlyArray<RecordedToolFailure>;
  readonly isCompleteTranscript: boolean;
}): boolean =>
  isCompleteTranscript &&
  calls.length > 0 &&
  calls.every((call) => isReplaySafeToolCall({ call, diagnostics }));
