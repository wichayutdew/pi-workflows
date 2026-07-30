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

/** Builds the immutable same-worktree constraint for a restarted iteration. */
export function buildRestartWorkspaceSection(
  workspaceCwd: string | undefined,
): ReadonlyArray<string> {
  if (!workspaceCwd) return [];
  return [
    '## Restart workspace constraint',
    '',
    `This iteration must reuse and rebind exactly this existing workspace: ${workspaceCwd}`,
    'Do not create or substitute another workspace. If it cannot be safely reused, complete with a configured non-binding outcome that pauses the workflow.',
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

/**
 * Builds the shared operator-facing format for non-successful step results.
 *
 * The summary is posted verbatim to chat and is the only context available to
 * a fresh child, so it must remain actionable without becoming a transcript.
 */
export function buildNonSuccessSummaryInstructions(
  outcomes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const nonSuccessOutcomes = outcomes.filter((outcome) =>
    ['blocked', 'failed', 'retry'].includes(outcome),
  );
  if (nonSuccessOutcomes.length === 0) return [];

  return [
    '## Human-readable non-success results',
    '',
    `For ${nonSuccessOutcomes.map((outcome) => `\`${outcome}\``).join(', ')}, write a decision-first summary. It is shown verbatim to the operator and handed to a fresh child. Use this format:`,
    '',
    '# <Failed | Blocked | Retry>: <one-sentence plain-language decision>',
    '1. **<short issue>** — <only the decisive evidence, including an exact command/error, path, or identifier when it enables action>.',
    '   **Action:** <the specific owner or role> must <the concrete evidence, decision, or change needed>.',
    '2. Repeat only for other independent issues (at most three total).',
    '**Next:** <the exact safe next move, such as provide the listed evidence and run `/workflow-resume`>.',
    '',
    'Do not include a process narrative, raw logs, repeated policy constraints, successful checks, clean-state notes, or statements that merely say the child lacks authority. Mention a passed check only when it directly explains the remaining issue. Name the missing prerequisite and who can supply it. Keep only details needed to make the decision or complete the next action.',
    '',
  ];
}
