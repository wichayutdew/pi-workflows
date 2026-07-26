import {
  diagnosticTextContent,
  diagnosticToolCallText,
  isDiagnosticRecord,
} from './diagnostic-text.ts';
import type {
  DelegationReplayAudit,
  DelegationReplayExpectation,
  RecordedToolCall,
  RecordedToolFailure,
} from './diagnostic-types.ts';
import { isReplaySafeToolCall } from './replay-safety.ts';

const initialDelegationTask = (transcript: string): string | undefined => {
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isDiagnosticRecord(entry) || entry.type !== 'message') continue;
    const message = entry.message;
    if (!isDiagnosticRecord(message) || message.role !== 'user') continue;
    if (!Array.isArray(message.content)) return undefined;
    const textParts = message.content.flatMap((item) =>
      isDiagnosticRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
        ? [item.text]
        : [],
    );
    return textParts.length === 1 ? textParts[0] : undefined;
  }
  return undefined;
};

/**
 * Audits whether a complete transcript can be safely replayed under the
 * expected delegated policy.
 */
export const parseDelegationReplayAudit = (
  transcript: string,
  expectation: DelegationReplayExpectation,
  isCompleteTranscript = true,
): DelegationReplayAudit => {
  const calls = new Map<string, RecordedToolCall>();
  const recordedCalls: Array<RecordedToolCall> = [];
  const diagnostics: Array<RecordedToolFailure> = [];
  const resultCallIds = new Set<string>();
  let isStructurallyValid = true;
  let order = 0;

  for (const line of transcript.split('\n')) {
    order += 1;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      isStructurallyValid = false;
      continue;
    }
    if (!isDiagnosticRecord(entry) || entry.type !== 'message') continue;
    const message = entry.message;
    if (!isDiagnosticRecord(message)) {
      isStructurallyValid = false;
      continue;
    }

    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) {
        isStructurallyValid = false;
        continue;
      }
      for (const item of message.content) {
        if (!isDiagnosticRecord(item) || item.type !== 'toolCall') continue;
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          calls.has(item.id)
        ) {
          isStructurallyValid = false;
          continue;
        }
        const call = diagnosticToolCallText({
          tool: item.name,
          argumentsValue: item.arguments,
        });
        const recordedCall: RecordedToolCall = {
          id: item.id,
          order,
          tool: item.name,
          ...(call ? { call } : {}),
        };
        calls.set(item.id, recordedCall);
        recordedCalls.push(recordedCall);
      }
      continue;
    }

    if (message.role !== 'toolResult') continue;
    if (
      typeof message.toolCallId !== 'string' ||
      typeof message.toolName !== 'string' ||
      typeof message.isError !== 'boolean' ||
      !Array.isArray(message.content) ||
      resultCallIds.has(message.toolCallId)
    ) {
      isStructurallyValid = false;
      continue;
    }
    resultCallIds.add(message.toolCallId);
    const recorded = calls.get(message.toolCallId);
    if (recorded?.tool !== message.toolName) {
      isStructurallyValid = false;
      continue;
    }
    if (message.isError) {
      const output = diagnosticTextContent(message.content);
      diagnostics.push({
        tool: message.toolName,
        callId: message.toolCallId,
        order,
        ...(recorded.call ? { call: recorded.call } : {}),
        ...(output ? { output } : {}),
      });
    }
  }

  return {
    replaySafe:
      isCompleteTranscript &&
      isStructurallyValid &&
      initialDelegationTask(transcript) === expectation.task &&
      recordedCalls.every((call) =>
        isReplaySafeToolCall({
          call,
          diagnostics,
          bashPermission: expectation.bashPermission,
        }),
      ),
    toolCount: recordedCalls.length,
  };
};
