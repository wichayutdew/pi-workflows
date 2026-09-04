import type { ToolInventoryItem, WorkflowStep } from '../../domain/index.ts';

const sourceText = (tool: ToolInventoryItem): string =>
  `${tool.sourceInfo?.source ?? ''}\n${tool.sourceInfo?.path ?? ''}`.toLowerCase();

const isMcpAdapterTool = (tool: ToolInventoryItem): boolean =>
  sourceText(tool).includes('pi-mcp-adapter');

/**
 * Determines whether a tool belongs to an allowed extension selector.
 *
 * Built-in and SDK tools are never treated as extension-provided tools.
 *
 * @param tool - Registered tool inventory item.
 * @param selector - Case-insensitive source or path fragment.
 * @returns `true` when the extension selector matches.
 */
export const matchesExtensionSelector = (
  tool: ToolInventoryItem,
  selector: string,
): boolean => {
  const source = tool.sourceInfo?.source;
  return (
    source !== 'builtin' &&
    source !== 'sdk' &&
    sourceText(tool).includes(selector.toLowerCase())
  );
};

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
        (tool.name === 'mcp' && step.permissions.mcp.length > 0) ||
        (!isMcpAdapterTool(tool) &&
          step.permissions.extensions.some((selector) =>
            matchesExtensionSelector(tool, selector),
          )),
    )
    .map((tool) => tool.name);
  return [...new Set(selectedToolNames)];
};

/**
 * Determines whether a tool can be authorized through an extension selector.
 *
 * @param tool - Registered tool inventory item.
 * @param selectors - Allowed extension selectors.
 * @returns `true` when a non-MCP-adapter extension selector matches.
 */
export const isAllowedExtensionTool = (
  tool: ToolInventoryItem,
  selectors: ReadonlyArray<string>,
): boolean =>
  !isMcpAdapterTool(tool) &&
  selectors.some((selector) => matchesExtensionSelector(tool, selector));
