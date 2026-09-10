import type {
  ToolAuthorization,
  ToolInventoryItem,
  WorkflowStep,
} from '../../domain/index.ts';
import { authorizeBash } from './bash.ts';
import { authorizeMcpProxy } from './mcp-authorization.ts';

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
 * @returns The authorization decision.
 */
export const authorizeToolCall = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  step: WorkflowStep,
  _inventory: ReadonlyArray<ToolInventoryItem>,
): ToolAuthorization => {
  void _inventory;
  if (toolName === 'mcp') {
    return authorizeMcpProxy(input, step.permissions.mcp);
  }

  const isAllowedByName = step.permissions.tools.includes(toolName);
  if (!isAllowedByName) {
    return reject(`tool "${toolName}" is not allowed for this workflow step`);
  }
  if (toolName !== 'bash') return { allowed: true };

  const command = input.command;
  if (typeof command !== 'string') {
    return reject('Bash call is missing command text');
  }
  const result = authorizeBash(command, step.permissions.bash);
  return result.allowed
    ? { allowed: true }
    : reject(result.reason ?? 'Bash command is not allowed');
};
