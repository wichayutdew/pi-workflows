import { comparableDiagnosticFragments } from './diagnostic-text.ts';
import type {
  RecordedCompletion,
  RecordedToolCall,
  RecordedToolFailure,
  ToolFailureDiagnostic,
} from './diagnostic-types.ts';
import { parseFailureTranscript } from './failure-transcript.ts';
import { reproduceHiddenBashFalsePositive } from './hidden-bash-failure.ts';
import { isFailureTranscriptReplaySafe } from './replay-safety.ts';

const diagnosticMatchesTerminalError = (
  diagnostic: ToolFailureDiagnostic,
  terminalError: string,
): boolean => {
  if (!diagnostic.output) return false;
  const detail =
    terminalError.match(
      /\b[a-z][\w-]* failed(?:\s*\([^)]*\))?\s*:\s*([\s\S]+)/i,
    )?.[1] ?? terminalError;
  const outputFragments = comparableDiagnosticFragments(diagnostic.output);
  const errorFragments = comparableDiagnosticFragments(
    `${terminalError}\n${detail}`,
  );
  return outputFragments.some((output) =>
    errorFragments.some(
      (error) => output.includes(error) || error.includes(output),
    ),
  );
};

const latestMatching = (
  diagnostics: ReadonlyArray<RecordedToolFailure>,
  predicate: (diagnostic: RecordedToolFailure) => boolean,
): RecordedToolFailure | undefined => {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index];
    if (diagnostic && predicate(diagnostic)) return diagnostic;
  }
  return undefined;
};

const finalCompletion = (
  completions: ReadonlyArray<RecordedCompletion>,
  latestFailureOrder: number,
  lastInteractionOrder: number,
  allowCompletionProof: boolean,
): RecordedCompletion | undefined => {
  if (!allowCompletionProof || completions.length !== 1) return undefined;
  const completion = completions[0];
  return completion &&
    completion.order > latestFailureOrder &&
    completion.order === lastInteractionOrder
    ? completion
    : undefined;
};

const publicDiagnostic = (
  diagnostic: RecordedToolFailure,
  diagnostics: ReadonlyArray<RecordedToolFailure>,
  recordedCalls: ReadonlyArray<RecordedToolCall>,
  successfulCompletions: ReadonlyArray<RecordedCompletion>,
  lastInteractionOrder: number,
  allowCompletionProof: boolean,
  correlation?: ToolFailureDiagnostic['correlation'],
): ToolFailureDiagnostic => {
  const result: ToolFailureDiagnostic = {
    tool: diagnostic.tool,
    ...(diagnostic.call ? { call: diagnostic.call } : {}),
    ...(diagnostic.output ? { output: diagnostic.output } : {}),
  };
  const latestFailureOrder = diagnostics.at(-1)?.order ?? diagnostic.order;
  const completion = finalCompletion(
    successfulCompletions,
    latestFailureOrder,
    lastInteractionOrder,
    allowCompletionProof,
  );
  return {
    ...result,
    ...(isFailureTranscriptReplaySafe({
      calls: recordedCalls,
      diagnostics,
      isCompleteTranscript: allowCompletionProof,
    })
      ? { replaySafe: true as const }
      : {}),
    ...(completion
      ? {
          completionAfterFailure: true as const,
          completionValue: completion.value,
        }
      : {}),
    ...(correlation ? { correlation } : {}),
  };
};

const hiddenFalsePositiveDiagnostic = (
  expectedTool: string | undefined,
  terminalError: string,
  allowCompletionProof: boolean,
  transcript: ReturnType<typeof parseFailureTranscript>,
): ToolFailureDiagnostic | undefined => {
  const {
    diagnostics,
    hasValidFalsePositiveProof,
    lastInteractionOrder,
    recordedCalls,
    recordedMessages,
    resultCallIds,
    successfulCompletions,
    successfulResults,
  } = transcript;
  if (diagnostics.length > 0) return undefined;

  const falsePositive = reproduceHiddenBashFalsePositive(
    recordedMessages,
    successfulResults,
  );
  const completion = falsePositive
    ? finalCompletion(
        successfulCompletions,
        falsePositive.result.order,
        lastInteractionOrder,
        allowCompletionProof,
      )
    : undefined;
  if (
    !hasValidFalsePositiveProof ||
    recordedCalls.length !== resultCallIds.size ||
    !recordedCalls.every((call) => resultCallIds.has(call.id)) ||
    recordedCalls.filter((call) => call.tool === 'structured_output').length !==
      1 ||
    expectedTool?.toLowerCase() !== 'bash' ||
    !falsePositive ||
    terminalError !== falsePositive.terminalError ||
    !completion
  ) {
    return undefined;
  }

  const successfulOutput = falsePositive.result;
  return {
    tool: successfulOutput.tool,
    ...(successfulOutput.call ? { call: successfulOutput.call } : {}),
    ...(successfulOutput.output ? { output: successfulOutput.output } : {}),
    completionAfterFailure: true,
    completionValue: completion.value,
    transcriptToolCount: recordedCalls.length,
    transcriptTurnCount: recordedMessages.filter(
      ({ value }) => value.role === 'assistant',
    ).length,
    correlation: 'successful-output-before-completion',
  };
};

/**
 * Correlates a terminal tool failure with trusted evidence from a child
 * transcript.
 */
export const parseToolFailureDiagnostic = (
  transcript: string,
  expectedTool?: string,
  terminalError?: string,
  allowCompletionProof = true,
): ToolFailureDiagnostic | undefined => {
  const parsed = parseFailureTranscript(transcript);
  const {
    diagnostics,
    lastInteractionOrder,
    recordedCalls,
    successfulCompletions,
  } = parsed;
  const matchesExpectedTool = (
    diagnostic: Pick<RecordedToolFailure, 'tool'>,
  ): boolean =>
    expectedTool === undefined ||
    diagnostic.tool.toLowerCase() === expectedTool.toLowerCase();

  let selected: RecordedToolFailure | undefined;
  if (terminalError) {
    selected = latestMatching(
      diagnostics,
      (diagnostic) =>
        matchesExpectedTool(diagnostic) &&
        diagnosticMatchesTerminalError(diagnostic, terminalError),
    );
    if (!selected) {
      const fallback = latestMatching(diagnostics, matchesExpectedTool);
      const latestFailureOrder = diagnostics.at(-1)?.order;
      if (
        fallback &&
        latestFailureOrder !== undefined &&
        finalCompletion(
          successfulCompletions,
          latestFailureOrder,
          lastInteractionOrder,
          allowCompletionProof,
        )
      ) {
        return publicDiagnostic(
          fallback,
          diagnostics,
          recordedCalls,
          successfulCompletions,
          lastInteractionOrder,
          allowCompletionProof,
          'latest-before-completion',
        );
      }
    }
    if (!selected) {
      const falsePositive = hiddenFalsePositiveDiagnostic(
        expectedTool,
        terminalError,
        allowCompletionProof,
        parsed,
      );
      if (falsePositive) return falsePositive;
    }
  } else {
    selected = latestMatching(diagnostics, matchesExpectedTool);
  }

  return selected
    ? publicDiagnostic(
        selected,
        diagnostics,
        recordedCalls,
        successfulCompletions,
        lastInteractionOrder,
        allowCompletionProof,
      )
    : undefined;
};
