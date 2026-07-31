import {
  diagnosticTextContent,
  diagnosticToolCallText,
  firstDiagnosticTextContent,
  isDiagnosticRecord,
  structuredCompletionValue,
} from './diagnostic-text.ts';
import type {
  ParsedFailureTranscript,
  RecordedCompletion,
  RecordedMessage,
  RecordedToolCall,
  RecordedToolFailure,
  RecordedToolSuccess,
  RecordedTranscriptWarning,
} from './diagnostic-types.ts';

const WATCHDOG_WARNING_TYPE = 'subagent_watchdog_warning';
const MAX_WARNING_FIELD_CHARS = 600;

const boundedWarningField = (value: string): string => {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  return normalized.length <= MAX_WARNING_FIELD_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_WARNING_FIELD_CHARS - 1)}…`;
};

const transcriptWarningContent = (
  entry: Readonly<Record<string, unknown>>,
): string | undefined => {
  if (
    entry.type !== 'custom_message' ||
    entry.customType !== WATCHDOG_WARNING_TYPE
  ) {
    return undefined;
  }
  const details = entry.details;
  if (isDiagnosticRecord(details)) {
    const fields = [
      typeof details.summary === 'string' ? details.summary : undefined,
      typeof details.evidence === 'string' ? details.evidence : undefined,
      typeof details.recommendedAction === 'string'
        ? `Recommended action: ${details.recommendedAction}`
        : undefined,
    ].filter((field): field is string => Boolean(field?.trim()));
    if (fields.length > 0) return boundedWarningField(fields.join(' '));
  }
  return typeof entry.content === 'string' && entry.content.trim()
    ? boundedWarningField(entry.content)
    : 'The child emitted an unresolved watchdog warning after completion.';
};

const isBenignTerminalAssistant = (
  message: Readonly<Record<string, unknown>>,
): boolean =>
  message.stopReason === 'stop' &&
  message.errorMessage === undefined &&
  Array.isArray(message.content) &&
  message.content.length === 1 &&
  isDiagnosticRecord(message.content[0]) &&
  message.content[0].type === 'text' &&
  message.content[0].text === '';

/**
 * Parses the tool calls, results, completions, and structural evidence needed
 * to correlate a terminal failure.
 */
export const parseFailureTranscript = (
  transcript: string,
): ParsedFailureTranscript => {
  const calls = new Map<string, RecordedToolCall>();
  const recordedCalls: Array<RecordedToolCall> = [];
  const diagnostics: Array<RecordedToolFailure> = [];
  const successfulResults: Array<RecordedToolSuccess> = [];
  const successfulCompletions: Array<RecordedCompletion> = [];
  const transcriptWarnings: Array<RecordedTranscriptWarning> = [];
  const recordedMessages: Array<RecordedMessage> = [];
  const resultCallIds = new Set<string>();
  let hasValidFalsePositiveProof = true;
  let lastInteractionOrder = 0;
  let order = 0;

  for (const line of transcript.split('\n')) {
    order += 1;
    if (!line.trim()) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      hasValidFalsePositiveProof = false;
      continue;
    }
    if (isDiagnosticRecord(entry)) {
      const warning = transcriptWarningContent(entry);
      if (warning) {
        transcriptWarnings.push({ order, content: warning });
        lastInteractionOrder = order;
        continue;
      }
    }
    if (!isDiagnosticRecord(entry) || entry.type !== 'message') continue;
    const message = entry.message;
    if (!isDiagnosticRecord(message)) {
      hasValidFalsePositiveProof = false;
      continue;
    }
    recordedMessages.push({ order, value: message });
    if (
      message.role === 'assistant' &&
      ((typeof message.errorMessage === 'string' &&
        message.errorMessage.trim().length > 0) ||
        message.stopReason === 'error' ||
        message.stopReason === 'aborted')
    ) {
      hasValidFalsePositiveProof = false;
    }

    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) {
        hasValidFalsePositiveProof = false;
        continue;
      }
      if (!isBenignTerminalAssistant(message)) {
        lastInteractionOrder = order;
      }
      const toolCalls = message.content.filter(
        (item): item is Record<string, unknown> =>
          isDiagnosticRecord(item) &&
          item.type === 'toolCall' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string',
      );
      for (const item of message.content) {
        if (
          !isDiagnosticRecord(item) ||
          item.type !== 'toolCall' ||
          typeof item.id !== 'string' ||
          typeof item.name !== 'string'
        ) {
          if (isDiagnosticRecord(item) && item.type === 'toolCall') {
            hasValidFalsePositiveProof = false;
          }
          continue;
        }
        if (calls.has(item.id)) hasValidFalsePositiveProof = false;

        const call = diagnosticToolCallText({
          tool: item.name,
          argumentsValue: item.arguments,
        });
        const isExclusiveCompletion =
          toolCalls.length === 1 &&
          message.content.every(
            (contentItem) =>
              isDiagnosticRecord(contentItem) &&
              (contentItem.type === 'thinking' ||
                contentItem.type === 'text' ||
                contentItem.type === 'toolCall'),
          );
        const completionValue =
          item.name === 'structured_output' && isExclusiveCompletion
            ? structuredCompletionValue(item.arguments)
            : undefined;
        const recordedCall: RecordedToolCall = {
          id: item.id,
          order,
          tool: item.name,
          ...(call ? { call } : {}),
          ...(completionValue ? { completionValue } : {}),
        };
        calls.set(item.id, recordedCall);
        recordedCalls.push(recordedCall);
      }
      continue;
    }

    if (message.role !== 'toolResult' || typeof message.toolName !== 'string') {
      if (message.role === 'toolResult') hasValidFalsePositiveProof = false;
      continue;
    }
    lastInteractionOrder = order;
    if (
      typeof message.toolCallId !== 'string' ||
      typeof message.isError !== 'boolean' ||
      !Array.isArray(message.content) ||
      resultCallIds.has(message.toolCallId)
    ) {
      hasValidFalsePositiveProof = false;
    }
    if (typeof message.toolCallId === 'string') {
      resultCallIds.add(message.toolCallId);
    }
    const recorded =
      typeof message.toolCallId === 'string'
        ? calls.get(message.toolCallId)
        : undefined;
    const doesCallMatchResult = recorded?.tool === message.toolName;
    if (!doesCallMatchResult) hasValidFalsePositiveProof = false;

    if (
      message.toolName === 'structured_output' &&
      message.isError === false &&
      doesCallMatchResult &&
      recorded.completionValue
    ) {
      successfulCompletions.push({
        order,
        value: recorded.completionValue,
      });
    }
    if (
      message.isError === false &&
      message.toolName !== 'structured_output' &&
      doesCallMatchResult
    ) {
      const output = diagnosticTextContent(message.content);
      const detectorOutput = firstDiagnosticTextContent(message.content);
      successfulResults.push({
        order,
        tool: message.toolName,
        ...(recorded.call ? { call: recorded.call } : {}),
        ...(output ? { output } : {}),
        ...(detectorOutput !== undefined ? { detectorOutput } : {}),
      });
    }
    if (message.isError !== true) continue;

    const output = diagnosticTextContent(message.content);
    diagnostics.push({
      tool: message.toolName,
      ...(doesCallMatchResult && recorded.call ? { call: recorded.call } : {}),
      ...(output ? { output } : {}),
      ...(doesCallMatchResult && typeof message.toolCallId === 'string'
        ? { callId: message.toolCallId }
        : {}),
      order,
    });
  }

  return {
    recordedCalls,
    diagnostics,
    successfulResults,
    successfulCompletions,
    transcriptWarnings,
    recordedMessages,
    resultCallIds,
    hasValidFalsePositiveProof,
    lastInteractionOrder,
  };
};
