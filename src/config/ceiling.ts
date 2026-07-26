import type {
  BashPermission,
  BashRule,
  PermissionCeiling,
  StepSubagent,
  SubagentPermissionCeiling,
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

function turnBudgetErrors(
  subagent: StepSubagent,
  ceiling: SubagentPermissionCeiling,
  path: string,
): Array<string> {
  if (!subagent.turnBudget) {
    return [`${path}.turnBudget: required for a project workflow`];
  }
  return [
    ...(subagent.turnBudget.maxTurns > ceiling.maxTurns
      ? [`${path}.turnBudget.maxTurns: exceeds the user permission ceiling`]
      : []),
    ...((subagent.turnBudget.graceTurns ?? 0) > ceiling.maxGraceTurns
      ? [`${path}.turnBudget.graceTurns: exceeds the user permission ceiling`]
      : []),
  ];
}

function toolBudgetErrors(
  subagent: StepSubagent,
  ceiling: SubagentPermissionCeiling,
  path: string,
): Array<string> {
  if (!subagent.toolBudget) {
    return [`${path}.toolBudget: required for a project workflow`];
  }
  return [
    ...(subagent.toolBudget.hard > ceiling.maxToolCalls
      ? [`${path}.toolBudget.hard: exceeds the user permission ceiling`]
      : []),
    ...(subagent.toolBudget.block !== '*'
      ? [`${path}.toolBudget.block: must be "*" for a project workflow`]
      : []),
  ];
}

function subagentErrors(
  subagent: StepSubagent | undefined,
  ceiling: SubagentPermissionCeiling | undefined,
  path: string,
): Array<string> {
  if (!subagent) return [];
  if (!ceiling) {
    return [`${path}: subagent execution exceeds the user permission ceiling`];
  }
  return [
    ...(!ceiling.agents.includes(subagent.agent)
      ? [
          `${path}.agent: "${subagent.agent}" exceeds the user permission ceiling`,
        ]
      : []),
    ...(!ceiling.contexts.includes(subagent.context)
      ? [
          `${path}.context: "${subagent.context}" exceeds the user permission ceiling`,
        ]
      : []),
    ...(subagent.model && !ceiling.models.includes(subagent.model)
      ? [
          `${path}.model: "${subagent.model}" exceeds the user permission ceiling`,
        ]
      : []),
    ...(subagent.timeoutMs > ceiling.maxTimeoutMs
      ? [`${path}.timeoutMs: exceeds the user permission ceiling`]
      : []),
    ...(subagent.artifacts && !ceiling.artifacts
      ? [`${path}.artifacts: exceeds the user permission ceiling`]
      : []),
    ...(subagent.retryToolFailures && !ceiling.retryToolFailures
      ? [`${path}.retryToolFailures: exceeds the user permission ceiling`]
      : []),
    ...turnBudgetErrors(subagent, ceiling, path),
    ...toolBudgetErrors(subagent, ceiling, path),
  ];
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
      ...subagentErrors(
        step.subagent,
        ceiling.subagent,
        `workflow.steps.${stepId}.subagent`,
      ),
    ];
  });
}
