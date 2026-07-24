import type { WorkflowStep } from "../config/types.ts";
import { authorizeBash } from "./bash.ts";

export interface ToolSourceInfo {
  source?: string;
  path?: string;
}

export interface ToolInventoryItem {
  name: string;
  sourceInfo?: ToolSourceInfo;
}

export interface ToolAuthorization {
  allowed: boolean;
  reason?: string;
}

function reject(reason: string): ToolAuthorization {
  return { allowed: false, reason };
}

function sourceText(tool: ToolInventoryItem): string {
  return `${tool.sourceInfo?.source ?? ""}\n${tool.sourceInfo?.path ?? ""}`.toLowerCase();
}

function isMcpAdapterTool(tool: ToolInventoryItem): boolean {
  return sourceText(tool).includes("pi-mcp-adapter");
}

export function matchesExtensionSelector(
  tool: ToolInventoryItem,
  selector: string,
): boolean {
  const source = tool.sourceInfo?.source;
  if (source === "builtin" || source === "sdk") return false;
  return sourceText(tool).includes(selector.toLowerCase());
}

export function resolveActiveTools(
  inventory: readonly ToolInventoryItem[],
  step: WorkflowStep,
  completionToolName: string,
): string[] {
  const exact = new Set(step.permissions.tools);
  const selected = inventory
    .filter(
      (tool) =>
        tool.name === completionToolName ||
        exact.has(tool.name) ||
        (tool.name === "mcp" && step.permissions.mcp.length > 0) ||
        (!isMcpAdapterTool(tool) &&
          step.permissions.extensions.some((selector) =>
            matchesExtensionSelector(tool, selector),
          )),
    )
    .map((tool) => tool.name);
  return [...new Set(selected)];
}

function selectorAllows(
  selectors: readonly string[],
  server: string,
  tool: string,
): boolean {
  return selectors.some((selector) => {
    const separator = selector.indexOf("/");
    if (separator === -1) return selector === server;
    return selector.slice(0, separator) === server && selector.slice(separator + 1) === tool;
  });
}

export function authorizeMcpProxy(
  input: Record<string, unknown>,
  selectors: readonly string[],
): ToolAuthorization {
  if (selectors.length === 0) {
    return reject("MCP access is disabled for this workflow step");
  }

  const unsupportedModes = [
    "action",
    "connect",
    "describe",
    "search",
    "regex",
    "includeSchemas",
  ].filter((field) => input[field] !== undefined);
  if (unsupportedModes.length > 0) {
    return reject(
      `MCP proxy mode "${unsupportedModes[0]}" is disabled; use an explicit server and tool`,
    );
  }
  if (typeof input.server !== "string" || !input.server.trim()) {
    return reject("MCP proxy calls must name an explicit server");
  }
  if (typeof input.tool !== "string" || !input.tool.trim()) {
    return reject("MCP proxy calls must name an explicit tool");
  }

  const server = input.server.trim();
  const tool = input.tool.trim();
  if (!selectorAllows(selectors, server, tool)) {
    return reject(`MCP tool "${server}/${tool}" is not allowed for this workflow step`);
  }
  return { allowed: true };
}

export function authorizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  step: WorkflowStep,
  inventory: readonly ToolInventoryItem[],
): ToolAuthorization {
  const tool = inventory.find((candidate) => candidate.name === toolName);
  const allowedByName = step.permissions.tools.includes(toolName);
  const allowedByExtension =
    tool !== undefined &&
    !isMcpAdapterTool(tool) &&
    step.permissions.extensions.some((selector) =>
      matchesExtensionSelector(tool, selector),
    );

  if (toolName === "mcp") {
    return authorizeMcpProxy(input, step.permissions.mcp);
  }
  if (!allowedByName && !allowedByExtension) {
    return reject(`tool "${toolName}" is not allowed for this workflow step`);
  }
  if (toolName === "bash") {
    const command = input.command;
    if (typeof command !== "string") return reject("Bash call is missing command text");
    const result = authorizeBash(command, step.permissions.bash);
    return result.allowed
      ? { allowed: true }
      : reject(result.reason ?? "Bash command is not allowed");
  }
  return { allowed: true };
}
