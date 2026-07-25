const MAX_DIAGNOSTIC_FIELD_CHARS = 1_600;
const TRUNCATION_MARKER = '… [truncated] …';

/**
 * Narrows an unknown transcript value to a plain record.
 */
export const isDiagnosticRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Bounds diagnostic text while preserving evidence from both ends.
 */
export const boundedDiagnosticText = (value: string): string => {
  if (value.length <= MAX_DIAGNOSTIC_FIELD_CHARS) return value;
  const available = MAX_DIAGNOSTIC_FIELD_CHARS - TRUNCATION_MARKER.length - 2;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}\n${TRUNCATION_MARKER}\n${value.slice(-endLength)}`;
};

/**
 * Joins and bounds every text item in a transcript content array.
 */
export const diagnosticTextContent = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) =>
      isDiagnosticRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('\n')
    .trim();
  return text ? boundedDiagnosticText(text) : undefined;
};

/**
 * Returns the first unmodified text item in transcript content.
 */
export const firstDiagnosticTextContent = (
  value: unknown,
): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const content: ReadonlyArray<unknown> = value;
  const text = content.find(
    (item) =>
      isDiagnosticRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string',
  );
  return isDiagnosticRecord(text) && typeof text.text === 'string'
    ? text.text
    : undefined;
};

/**
 * Formats a tool call for bounded diagnostic output.
 */
export const diagnosticToolCallText = ({
  tool,
  argumentsValue,
}: {
  readonly tool: string;
  readonly argumentsValue: unknown;
}): string | undefined => {
  if (!isDiagnosticRecord(argumentsValue)) return undefined;
  if (tool === 'bash') {
    const command = argumentsValue.command ?? argumentsValue.cmd;
    if (typeof command === 'string' && command.trim()) {
      return boundedDiagnosticText(command.trim());
    }
  }
  return boundedDiagnosticText(JSON.stringify(argumentsValue));
};

/**
 * Extracts the value from an exclusive structured-output argument shape.
 */
export const structuredCompletionValue = (
  argumentsValue: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isDiagnosticRecord(argumentsValue)) return undefined;
  if (
    Object.keys(argumentsValue).length !== 1 ||
    !Object.hasOwn(argumentsValue, 'value') ||
    !isDiagnosticRecord(argumentsValue.value)
  ) {
    return undefined;
  }
  return argumentsValue.value;
};

const normalizeDiagnosticText = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Produces normalized, non-trivial fragments for error correlation.
 */
export const comparableDiagnosticFragments = (
  value: string,
): ReadonlyArray<string> => {
  const normalizedValue = normalizeDiagnosticText(value);
  const lines = value
    .split(/\r?\n/)
    .map(normalizeDiagnosticText)
    .filter((line) => line.length >= 8);
  return [...new Set([normalizedValue, ...lines])].filter(
    (fragment) => fragment.length >= 8,
  );
};
