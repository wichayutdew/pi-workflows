import type { ToolFailureDiagnostic } from './diagnostic-types.ts';

/**
 * Extracts a failed tool name from a terminal error string.
 */
export const failedToolName = (error: string | undefined): string | undefined =>
  error?.match(/\b([a-z][\w-]*) failed(?:\s*\(|:)/i)?.[1];

/**
 * Formats a correlated tool failure as concise human-readable lines.
 */
export const formatToolFailureDiagnostic = (
  diagnostic: ToolFailureDiagnostic,
): Array<string> => {
  const hasSuccessfulOutputCorrelation =
    diagnostic.correlation === 'successful-output-before-completion';
  return [
    `${hasSuccessfulOutputCorrelation ? 'Terminal-reported tool' : 'Failed tool'}: ${diagnostic.tool}`,
    ...(diagnostic.call
      ? [
          `${diagnostic.tool === 'bash' ? 'Command' : 'Arguments'}: ${diagnostic.call}`,
        ]
      : []),
    ...(diagnostic.output
      ? [
          `${hasSuccessfulOutputCorrelation ? 'Successful tool output' : 'Tool error'}: ${diagnostic.output}`,
        ]
      : []),
    ...(diagnostic.correlation === 'latest-before-completion'
      ? [
          'Correlation: latest failed tool call before successful structured_output; terminal text did not identify the call',
        ]
      : []),
    ...(hasSuccessfulOutputCorrelation
      ? [
          'Correlation: terminal error text came from a successful tool result before the final structured_output',
        ]
      : []),
  ];
};
