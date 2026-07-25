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
export function buildDelegatedCompletionInstructions(
  step: WorkflowStep,
): ReadonlyArray<string> {
  const finalContractInstruction = step.gate
    ? 'Put every unresolved decision in the gate artifact with evidence, options, a recommendation, and an adopted default; do not ask a terminal question.'
    : 'Treat the step instructions and incoming handoff as the final execution contract; do not ask a terminal question.';

  return [
    'This child is non-interactive. Never call `contact_supervisor`, `subagent_supervisor`, or `intercom`.',
    'When a tool or command fails, inspect its exact error, diagnose the cause, and try a permitted semantically equivalent alternative before ending the step. Continue the original work after recovery; do not treat the first recoverable failure as terminal.',
    'Never broaden mutation targets or external side effects while recovering. Before using a pause outcome, exhaust safe permitted alternatives and include the exact failed call, exact error, alternatives attempted, observed state, and why recovery is impossible.',
    finalContractInstruction,
  ];
}
