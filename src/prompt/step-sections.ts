import type { WorkflowStep } from '../config/types.ts';

type StepExecution = 'delegated' | 'main';

const formatList = (values: ReadonlyArray<string>): string =>
  values.length > 0 ? values.join(', ') : '(none)';

type BuildResourceSectionOptions = {
  readonly execution: StepExecution;
  readonly step: WorkflowStep;
};

/**
 * Builds the resource-policy section shared by delegated and main steps.
 *
 * @param options - Step execution kind and resource permissions.
 * @returns Lines for the resource-policy prompt section.
 */
export function buildResourceSection({
  execution,
  step,
}: BuildResourceSectionOptions): ReadonlyArray<string> {
  const isDelegated = execution === 'delegated';

  return [
    `## Enforced ${isDelegated ? 'child' : 'step'} resources`,
    '',
    `Pi tools: ${formatList(step.permissions.tools)}`,
    `MCP selectors: ${formatList(step.permissions.mcp)}`,
    `Extension selectors: ${formatList(step.permissions.extensions)}`,
    `Skills: ${formatList(step.permissions.skills)}`,
    `Bash policy: ${step.permissions.bash.mode}`,
    `Bash allow rules: ${
      step.permissions.bash.allow.length > 0
        ? JSON.stringify(step.permissions.bash.allow)
        : '(none)'
    }`,
    '',
    `Use only the listed skills for this step. Tool calls are enforced ${isDelegated ? 'inside this child process' : 'by the workflow harness'}.`,
    '',
  ];
}

/**
 * Builds the explicit previous-step handoff section for a delegated child.
 *
 * @param handoff - Compact handoff supplied to the fresh child context.
 * @returns Lines for the previous-step handoff section.
 */
export function buildDelegatedHandoffSection(
  handoff: string,
): ReadonlyArray<string> {
  return [
    '## Previous step handoff',
    '',
    handoff || '(none; this is the first workflow step)',
    '',
  ];
}

/**
 * Builds non-interactive recovery guidance specific to delegated steps.
 *
 * @param step - Active delegated workflow step.
 * @returns Delegated completion-guidance lines.
 */
export function buildDelegatedCompletionInstructions(): ReadonlyArray<string> {
  return [
    'This child is non-interactive. Never call `contact_supervisor`, `subagent_supervisor`, or `intercom`.',
    'Follow the step instructions when choosing one valid outcome; outcome names have no built-in domain meaning.',
    'Stay within the configured permissions and do not broaden mutation targets or external side effects.',
  ];
}
