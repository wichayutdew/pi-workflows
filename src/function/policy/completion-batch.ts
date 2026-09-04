type ToolCallContent = {
  readonly type: 'toolCall';
  readonly id: string;
  readonly name: string;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toolCalls = (message: unknown): Array<ToolCallContent> => {
  if (!isRecord(message)) return [];
  if (message.role !== 'assistant' || !Array.isArray(message.content))
    return [];

  return message.content.filter(
    (item): item is ToolCallContent =>
      isRecord(item) &&
      item.type === 'toolCall' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string',
  );
};

/**
 * A completion changes the active step and its permissions. It is therefore
 * safe only when it is the sole tool call in an assistant message.
 *
 * @param message - Assistant message to validate.
 * @param completionTool - Workflow completion tool name.
 * @returns IDs of invalid completion calls.
 */
export function invalidCompletionCallIds(
  message: unknown,
  completionTool: string,
): Set<string> {
  const calls = toolCalls(message);
  if (calls.length === 1 && calls[0]?.name === completionTool) return new Set();
  return new Set(
    calls.filter((call) => call.name === completionTool).map((call) => call.id),
  );
}
