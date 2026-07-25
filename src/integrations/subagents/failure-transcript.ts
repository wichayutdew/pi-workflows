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
} from './diagnostic-types.ts';

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
      lastInteractionOrder = order;
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
    recordedMessages,
    resultCallIds,
    hasValidFalsePositiveProof,
    lastInteractionOrder,
  };
};
