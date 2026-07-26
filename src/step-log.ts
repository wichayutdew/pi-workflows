import { MAX_STEP_TRACE_LOG_EVENT_CHARS } from './engine/state-types.ts';

const REDACTED = '[redacted]';
const SECRET_KEY =
  /(?:^|[-_])(authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret)(?:$|[-_])/i;
const LABELED_VALUE =
  /(^|[^A-Za-z0-9_])([A-Za-z0-9_-]*(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|credential|token|secret)[A-Za-z0-9_-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gim;

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sanitizeControls = (value: string): string => {
  let safe = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isAllowedWhitespace = code === 9 || code === 10;
    if (
      (!isAllowedWhitespace && code < 32) ||
      code === 127 ||
      (code >= 128 && code <= 159)
    ) {
      continue;
    }
    safe += character;
  }
  return safe.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
};

/** Removes terminal control bytes and bounds one persisted/displayed log event. */
export function sanitizeStepLogText(value: string): string {
  const normalized = sanitizeControls(value);
  return normalized.length <= MAX_STEP_TRACE_LOG_EVENT_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_STEP_TRACE_LOG_EVENT_CHARS - 1)}…`;
}

const redactStructured = (value: unknown, depth = 0): unknown => {
  if (depth > 20) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return value.map((item) => redactStructured(item, depth + 1));
  }
  if (!isRecord(value)) {
    return typeof value === 'string' ? sanitizeStepLogText(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(`-${key}-`)
        ? REDACTED
        : redactStructured(item, depth + 1),
    ]),
  );
};

const redactCommonCredentials = (value: string): string =>
  value
    .replaceAll(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(
      LABELED_VALUE,
      (original: string, prefix: string, key: string): string =>
        SECRET_KEY.test(`-${key}-`) ? `${prefix}${key}=${REDACTED}` : original,
    );

/** Removes terminal controls and common credential forms from one log event. */
export function redactStepLogText(value: string): string {
  return redactCommonCredentials(sanitizeStepLogText(value));
}

/** Redacts a checkpoint-bounded detail field without per-event truncation. */
export function redactStepDetailText(value: string): string {
  return redactCommonCredentials(sanitizeControls(value));
}

/** Formats and redacts an unknown structured value for a step log. */
export function redactStepLogValue(value: unknown): string {
  if (typeof value === 'string') return redactStepLogText(value);
  try {
    return redactStepLogText(
      JSON.stringify(redactStructured(value), undefined, 2),
    );
  } catch {
    return '[unserializable value]';
  }
}

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return redactStepLogText(content);
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      if (item.type === 'text' && typeof item.text === 'string') {
        return [item.text];
      }
      if (item.type === 'image') return ['[image]'];
      if (item.type === 'audio') return ['[audio]'];
      return [];
    })
    .map(redactStepLogText)
    .filter(Boolean)
    .join('\n');
};

/**
 * Returns exact text only for a text-only user message.
 *
 * Pi converts extension-supplied workflow tasks to one or more text blocks.
 * Rejecting non-text blocks keeps trace arming tied to that exact task shape.
 */
export function textOnlyUserMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (
    !Array.isArray(message.content) ||
    message.content.some(
      (item) =>
        !isRecord(item) ||
        item.type !== 'text' ||
        typeof item.text !== 'string',
    )
  ) {
    return undefined;
  }
  return message.content
    .map((item) => (item as { readonly text: string }).text)
    .join('\n');
}

/** Projects one finalized assistant or tool-result message to safe log lines. */
export function stepLogLinesFromMessage(message: unknown): Array<string> {
  if (!isRecord(message)) return [];
  if (message.role === 'assistant') {
    if (!Array.isArray(message.content)) return [];
    const contentLines = message.content.flatMap((item) => {
      if (!isRecord(item)) return [];
      if (item.type === 'text' && typeof item.text === 'string') {
        const text = redactStepLogText(item.text);
        return text ? [`assistant\n${text}`] : [];
      }
      if (item.type === 'toolCall' && typeof item.name === 'string') {
        const argumentsText = redactStepLogValue(item.arguments);
        return [
          `tool call · ${sanitizeStepLogText(item.name)}${
            argumentsText ? `\n${argumentsText}` : ''
          }`,
        ];
      }
      // Thinking is intentionally excluded from persisted and displayed logs.
      return [];
    });
    const error =
      typeof message.errorMessage === 'string'
        ? redactStepLogText(message.errorMessage)
        : '';
    return [...contentLines, ...(error ? [`assistant error\n${error}`] : [])];
  }
  if (message.role !== 'toolResult') return [];
  const tool =
    typeof message.toolName === 'string'
      ? sanitizeStepLogText(message.toolName)
      : 'unknown tool';
  const result = contentText(message.content);
  const state = message.isError === true ? 'error' : 'result';
  return [`tool ${state} · ${tool}${result ? `\n${result}` : ''}`];
}

/** Projects a finalized Pi turn in stable assistant/source-result order. */
export function stepLogLinesFromTurn(
  message: unknown,
  toolResults: ReadonlyArray<unknown>,
): Array<string> {
  return [
    ...stepLogLinesFromMessage(message),
    ...toolResults.flatMap(stepLogLinesFromMessage),
  ];
}
