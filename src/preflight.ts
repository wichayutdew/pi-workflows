import type { WorkflowStep } from "./config/types.ts";

interface SourceInfoLike {
  source?: string;
  path?: string;
}

interface NamedResource {
  name: string;
  sourceInfo?: SourceInfoLike;
}

export interface PreflightInventory {
  tools: readonly NamedResource[];
  commands: readonly NamedResource[];
  skills: ReadonlySet<string>;
}

function sourceMatches(resource: NamedResource, selector: string): boolean {
  const source = `${resource.sourceInfo?.source ?? ""}\n${resource.sourceInfo?.path ?? ""}`;
  return source.toLowerCase().includes(selector.toLowerCase());
}

export function preflightStep(
  step: WorkflowStep,
  inventory: PreflightInventory,
): string[] {
  const errors: string[] = [];
  const toolNames = new Set(inventory.tools.map((tool) => tool.name));
  const subagentTool = inventory.tools.find(
    (tool) => tool.name === "subagent" && sourceMatches(tool, "pi-subagents"),
  );

  if (!subagentTool) {
    errors.push(
      'pi-subagents is required, but its "subagent" tool is not installed or detectable',
    );
  }

  for (const tool of step.requires.tools) {
    if (!toolNames.has(tool)) {
      errors.push(`required tool "${tool}" is not installed`);
    }
  }
  if (step.permissions.mcp.length > 0 && !toolNames.has("mcp")) {
    errors.push('MCP selectors are configured, but the "mcp" proxy tool is not installed');
  }

  const extensionResources = [...inventory.tools, ...inventory.commands];
  for (const extension of step.requires.extensions) {
    if (!extensionResources.some((resource) => sourceMatches(resource, extension))) {
      errors.push(`required extension "${extension}" is not detectable`);
    }
  }
  for (const skill of step.requires.skills) {
    if (!inventory.skills.has(skill)) {
      errors.push(`required skill "${skill}" is not loaded`);
    }
  }
  return errors;
}
