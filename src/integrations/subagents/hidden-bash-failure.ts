import {
  firstDiagnosticTextContent,
  isDiagnosticRecord,
} from './diagnostic-text.ts';
import type {
  RecordedMessage,
  RecordedToolSuccess,
} from './diagnostic-types.ts';

const HIDDEN_BASH_FATAL_PATTERNS = [
  /command not found/i,
  /permission denied/i,
  /no such file or directory/i,
  /segmentation fault/i,
  /killed|terminated/i,
  /out of memory/i,
  /connection refused/i,
  /timeout/i,
] as const;
const HIDDEN_BASH_EXIT_PATTERN =
  /exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i;

export type HiddenBashFalsePositive = {
  readonly result: RecordedToolSuccess;
  readonly terminalError: string;
};

const lastAssistantTextIndex = (
  messages: ReadonlyArray<RecordedMessage>,
): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.value;
    const hasAssistantText =
      message?.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(
        (item) =>
          isDiagnosticRecord(item) &&
          item.type === 'text' &&
          typeof item.text === 'string' &&
          item.text.trim().length > 0,
      );
    if (hasAssistantText) return index;
  }
  return -1;
};

const hiddenExitCode = (output: string): number | undefined => {
  const exitCodeText = output.match(HIDDEN_BASH_EXIT_PATTERN)?.[1];
  const exitCode =
    exitCodeText === undefined ? undefined : Number.parseInt(exitCodeText, 10);
  if (exitCode !== undefined && exitCode !== 0) return exitCode;
  return HIDDEN_BASH_FATAL_PATTERNS.some((pattern) => pattern.test(output))
    ? 1
    : undefined;
};

/**
 * Reproduces pi-subagents' hidden Bash failure detection from successful tool
 * output.
 */
export const reproduceHiddenBashFalsePositive = (
  messages: ReadonlyArray<RecordedMessage>,
  successfulResults: ReadonlyArray<RecordedToolSuccess>,
): HiddenBashFalsePositive | undefined => {
  const assistantTextIndex = lastAssistantTextIndex(messages);
  const scanStart = assistantTextIndex >= 0 ? assistantTextIndex + 1 : 0;

  for (let index = messages.length - 1; index >= scanStart; index -= 1) {
    const recordedMessage = messages[index];
    const message = recordedMessage?.value;
    if (
      !recordedMessage ||
      message?.role !== 'toolResult' ||
      message.toolName !== 'bash' ||
      message.isError !== false
    ) {
      continue;
    }
    const output = firstDiagnosticTextContent(message.content);
    if (output === undefined) continue;

    const detectedExitCode = hiddenExitCode(output);
    if (detectedExitCode === undefined) continue;
    const result = successfulResults.find(
      (candidate) =>
        candidate.order === recordedMessage.order &&
        candidate.tool === 'bash' &&
        candidate.detectorOutput === output,
    );
    if (!result) return undefined;
    return {
      result,
      terminalError: `bash failed (exit ${detectedExitCode}): ${output.slice(0, 200)}`,
    };
  }
  return undefined;
};
