import type {
  BashPermission,
  BashRule,
  PermissionCeiling,
  WorkflowDefinition,
} from './types.ts';

function selectorAllowed(
  requested: string,
  ceiling: readonly string[],
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
  if (ceiling.mode === 'read-only') return requested.mode === 'read-only';
  if (requested.mode !== 'allow-list') return false;

  const allowedRules = new Set(ceiling.allow.map(ruleKey));
  const allowedSources = new Set(ceiling.approvedSources ?? []);
  return (
    requested.allow.every((rule) => allowedRules.has(ruleKey(rule))) &&
    (requested.approvedSources ?? []).every((source) =>
      allowedSources.has(source),
    )
  );
}

export function checkWorkflowAgainstCeiling(
  workflow: WorkflowDefinition,
  ceiling: PermissionCeiling,
): string[] {
  const errors: string[] = [];
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    const path = `workflow.steps.${stepId}.permissions`;
    const subagentPath = `workflow.steps.${stepId}.subagent`;
    for (const tool of step.permissions.tools) {
      if (!ceiling.tools.includes(tool)) {
        errors.push(
          `${path}.tools: "${tool}" exceeds the user permission ceiling`,
        );
      }
    }
    for (const selector of step.permissions.mcp) {
      if (!selectorAllowed(selector, ceiling.mcp)) {
        errors.push(
          `${path}.mcp: "${selector}" exceeds the user permission ceiling`,
        );
      }
    }
    for (const extension of step.permissions.extensions) {
      if (!ceiling.extensions.includes(extension)) {
        errors.push(
          `${path}.extensions: "${extension}" exceeds the user permission ceiling`,
        );
      }
    }
    for (const skill of step.permissions.skills) {
      if (!ceiling.skills.includes(skill)) {
        errors.push(
          `${path}.skills: "${skill}" exceeds the user permission ceiling`,
        );
      }
    }
    if (!bashWithinCeiling(step.permissions.bash, ceiling.bash)) {
      errors.push(`${path}.bash: exceeds the user permission ceiling`);
    }
    if (!step.subagent) continue;
    if (!ceiling.subagent) {
      errors.push(
        `${subagentPath}: subagent execution exceeds the user permission ceiling`,
      );
      continue;
    }
    if (!ceiling.subagent.agents.includes(step.subagent.agent)) {
      errors.push(
        `${subagentPath}.agent: "${step.subagent.agent}" exceeds the user permission ceiling`,
      );
    }
    if (!ceiling.subagent.contexts.includes(step.subagent.context)) {
      errors.push(
        `${subagentPath}.context: "${step.subagent.context}" exceeds the user permission ceiling`,
      );
    }
    if (
      step.subagent.model &&
      !ceiling.subagent.models.includes(step.subagent.model)
    ) {
      errors.push(
        `${subagentPath}.model: "${step.subagent.model}" exceeds the user permission ceiling`,
      );
    }
    if (step.subagent.timeoutMs > ceiling.subagent.maxTimeoutMs) {
      errors.push(
        `${subagentPath}.timeoutMs: exceeds the user permission ceiling`,
      );
    }
    if (step.subagent.artifacts && !ceiling.subagent.artifacts) {
      errors.push(
        `${subagentPath}.artifacts: exceeds the user permission ceiling`,
      );
    }
    if (!step.subagent.turnBudget) {
      errors.push(
        `${subagentPath}.turnBudget: required for a project workflow`,
      );
    } else {
      if (step.subagent.turnBudget.maxTurns > ceiling.subagent.maxTurns) {
        errors.push(
          `${subagentPath}.turnBudget.maxTurns: exceeds the user permission ceiling`,
        );
      }
      if (
        (step.subagent.turnBudget.graceTurns ?? 0) >
        ceiling.subagent.maxGraceTurns
      ) {
        errors.push(
          `${subagentPath}.turnBudget.graceTurns: exceeds the user permission ceiling`,
        );
      }
    }
    if (!step.subagent.toolBudget) {
      errors.push(
        `${subagentPath}.toolBudget: required for a project workflow`,
      );
    } else {
      if (step.subagent.toolBudget.hard > ceiling.subagent.maxToolCalls) {
        errors.push(
          `${subagentPath}.toolBudget.hard: exceeds the user permission ceiling`,
        );
      }
      if (step.subagent.toolBudget.block !== '*') {
        errors.push(
          `${subagentPath}.toolBudget.block: must be "*" for a project workflow`,
        );
      }
    }
  }
  return errors;
}
