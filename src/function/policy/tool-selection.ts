import type { ToolInventoryItem, WorkflowStep } from '../../domain/index.ts';

/**
 * Selects tools available to the active workflow step.
 *
 * @param inventory - Registered tool inventory.
 * @param step - Active workflow step.
 * @param completionToolName - Completion tool that must always remain active.
 * @returns Unique selected tool names in inventory order.
 */
export const resolveActiveTools = (
  inventory: ReadonlyArray<ToolInventoryItem>,
  step: WorkflowStep,
  completionToolName: string,
): Array<string> => {
  const exactToolNames = new Set(step.permissions.tools);
  const selectedToolNames = inventory
    .filter(
      (tool) =>
        tool.name === completionToolName ||
        exactToolNames.has(tool.name) ||
        (tool.name === 'mcp' && step.permissions.mcp.length > 0),
    )
    .map((tool) => tool.name);
  return [...new Set(selectedToolNames)];
};
