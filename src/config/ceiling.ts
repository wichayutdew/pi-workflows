import type {
  BashPermission,
  BashRule,
  PermissionCeiling,
  WorkflowDefinition,
} from './types.ts';

function selectorAllowed(
  requested: string,
  ceiling: ReadonlyArray<string>,
): boolean {
  const separator = requested.indexOf('/');
  if (separator === -1) return ceiling.includes(requested);
  const server = requested.slice(0, separator);
  return ceiling.includes(server) || ceiling.includes(requested);
}

function ruleKey(rule: BashRule): string {
  return JSON.stringify([rule.executable, rule.argsPrefix]);
}

function bashWithinCeiling(
  requested: BashPermission,
  ceiling: BashPermission,
): boolean {
  if (ceiling.mode === 'unrestricted') return true;
  if (requested.mode === 'deny') return true;
  if (ceiling.mode === 'deny') return false;
  if (requested.mode !== 'allow-list') return false;

  const allowedRules = new Set(ceiling.allow.map(ruleKey));
  return requested.allow.every((rule) => allowedRules.has(ruleKey(rule)));
}

/** Return every project-workflow permission that exceeds the user ceiling. */
export function checkWorkflowAgainstCeiling(
  workflow: WorkflowDefinition,
  ceiling: PermissionCeiling,
): Array<string> {
  return Object.entries(workflow.steps).flatMap(([stepId, step]) => {
    const path = `workflow.steps.${stepId}.permissions`;
    return [
      ...(Object.hasOwn(step, 'workspace')
        ? [
            `workflow.steps.${stepId}.workspace: workspace binding is unavailable to project workflows`,
          ]
        : []),
      ...step.permissions.tools
        .filter((tool) => !ceiling.tools.includes(tool))
        .map(
          (tool) =>
            `${path}.tools: "${tool}" exceeds the user permission ceiling`,
        ),
      ...step.permissions.mcp
        .filter((selector) => !selectorAllowed(selector, ceiling.mcp))
        .map(
          (selector) =>
            `${path}.mcp: "${selector}" exceeds the user permission ceiling`,
        ),
      ...step.permissions.extensions
        .filter((extension) => !ceiling.extensions.includes(extension))
        .map(
          (extension) =>
            `${path}.extensions: "${extension}" exceeds the user permission ceiling`,
        ),
      ...step.permissions.skills
        .filter((skill) => !ceiling.skills.includes(skill))
        .map(
          (skill) =>
            `${path}.skills: "${skill}" exceeds the user permission ceiling`,
        ),
      ...(!bashWithinCeiling(step.permissions.bash, ceiling.bash)
        ? [`${path}.bash: exceeds the user permission ceiling`]
        : []),
    ];
  });
}
