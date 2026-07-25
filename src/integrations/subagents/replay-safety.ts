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
const PRE_EXECUTION_BASH_FAILURES = [
  'command does not match this step',
  'environment assignments are not allowed',
  'not enabled by subagent',
  'shell operators, substitutions, expansions, and comments are not allowed',
  'shell wrapper',
  'substitutions and escapes are not allowed inside double quotes',
  'trailing bash escape is not allowed',
  'unterminated bash quote',
  'unquoted pathname and tilde expansion are not allowed',
] as const;

const isPreExecutionBashFailure = (output: string | undefined): boolean => {
  if (!output) return false;
  const normalizedOutput = output.toLowerCase();
  return PRE_EXECUTION_BASH_FAILURES.some((fragment) =>
    normalizedOutput.includes(fragment),
  );
};

/**
 * Returns whether replaying a recorded call cannot repeat a mutation.
 */
export const isReplaySafeToolCall = ({
  call,
  diagnostics,
  bashPermission,
  approvedBashCommands = [],
}: {
  readonly call: RecordedToolCall;
  readonly diagnostics: ReadonlyArray<RecordedToolFailure>;
  readonly bashPermission?: BashPermission;
  readonly approvedBashCommands?: ReadonlyArray<string>;
}): boolean => {
  const tool = call.tool.toLowerCase();
  if (REPLAY_SAFE_TOOLS.has(tool)) return true;
  if (tool !== 'bash' || !call.call) return false;
  if (authorizeBash(call.call, { mode: 'read-only', allow: [] }).allowed) {
    return true;
  }
  if (
    !bashPermission ||
    authorizeBash(call.call, bashPermission, approvedBashCommands).allowed
  ) {
    return false;
  }
  const failure = diagnostics.find(
    (diagnostic) => diagnostic.callId === call.id,
  );
  return isPreExecutionBashFailure(failure?.output);
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
