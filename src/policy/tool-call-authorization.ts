import type { WorkflowStep } from '../config/types.ts';
import { authorizeBash } from './bash.ts';
import { authorizeMcpProxy } from './mcp-authorization.ts';
import { isAllowedExtensionTool } from './tool-selection.ts';
import type { ToolAuthorization, ToolInventoryItem } from './tool-types.ts';

const reject = (reason: string): ToolAuthorization => ({
  allowed: false,
  reason,
});

/**
 * Authorizes a tool call against the active workflow-step policy.
 *
 * MCP and Bash calls receive their additional protocol-specific validation
 * after the tool itself has been selected.
 *
 * @param toolName - Requested tool name.
 * @param input - Requested tool input.
 * @param step - Active workflow step.
 * @param inventory - Registered tool inventory.
 * @param approvedBashCommands - Exact commands derived from human review.
 * @returns The authorization decision.
 */
export const authorizeToolCall = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  step: WorkflowStep,
  inventory: ReadonlyArray<ToolInventoryItem>,
  approvedBashCommands: ReadonlyArray<string> = [],
): ToolAuthorization => {
  if (toolName === 'mcp') {
    return authorizeMcpProxy(input, step.permissions.mcp);
  }

  const tool = inventory.find((candidate) => candidate.name === toolName);
  const isAllowedByName = step.permissions.tools.includes(toolName);
  const isAllowedByExtension =
    tool !== undefined &&
    isAllowedExtensionTool(tool, step.permissions.extensions);
  if (!isAllowedByName && !isAllowedByExtension) {
    return reject(`tool "${toolName}" is not allowed for this workflow step`);
  }
  if (toolName !== 'bash') return { allowed: true };

  const command = input.command;
  if (typeof command !== 'string') {
    return reject('Bash call is missing command text');
  }
  const result = authorizeBash(
    command,
    step.permissions.bash,
    approvedBashCommands,
  );
  return result.allowed
    ? { allowed: true }
    : reject(result.reason ?? 'Bash command is not allowed');
};
