interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
}

function toolCalls(message: unknown): ToolCallContent[] {
  if (message === null || typeof message !== "object") return [];
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return [];

  return candidate.content.filter(
    (item): item is ToolCallContent =>
      item !== null &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { name?: unknown }).name === "string",
  );
}

/**
 * A completion changes the active step and its permissions. It is therefore
 * safe only when it is the sole tool call in an assistant message.
 */
export function invalidCompletionCallIds(
  message: unknown,
  completionTool: string,
): Set<string> {
  const calls = toolCalls(message);
  if (calls.length === 1 && calls[0]?.name === completionTool) return new Set();
  return new Set(
    calls
      .filter((call) => call.name === completionTool)
      .map((call) => call.id),
  );
}
