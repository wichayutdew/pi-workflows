import type { WorkflowStepResult } from '../../runtime/step-result.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';
import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';

export const COMPLETION_REPAIR_PROMPT = [
  'The delegated step settled without its required correlated result.',
  'Do not repeat completed work and do not execute work tools.',
  'Call `structured_output` exactly once, alone, with one configured outcome and the required summary, artifact, and workspace fields.',
].join('\n');

export const toolBudgetWarningPrompt = ({
  productiveCalls,
  productiveRemaining,
  handoffReserve,
}: {
  readonly productiveCalls: number;
  readonly productiveRemaining: number;
  readonly handoffReserve: number;
}): string =>
  [
    'Tool-call budget warning.',
    `Productive calls used: ${productiveCalls}.`,
    `Productive calls remaining: ${productiveRemaining}.`,
    `Handoff reserve: ${handoffReserve} calls.`,
    'Begin preparing a compact handoff now.',
  ].join('\n');

export const TOOL_BUDGET_HANDOFF_PROMPT = [
  'The productive tool-call budget is exhausted.',
  'Work tools are locked; do not execute further work.',
  'Call `structured_output` exactly once, alone, with a detailed configured result if you can complete now.',
  'If you settle without a result, the extension persists an `handoff` result for a fresh child.',
].join('\n');

/** Builds the only extension-owned result allowed after productive budget exhaustion. */
export const toolBudgetHandoffResult = (
  policy: ChildStepPolicy,
  productiveCalls: number,
  toolLedger: ReadonlyArray<string> = [],
  settledEarly = false,
): WorkflowStepResult => {
  if (policy.handoffOutcome !== 'handoff') {
    throw new Error(
      'tool-budget handoff requires a configured handoff outcome',
    );
  }
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: policy.handoffOutcome,
    summary: [
      settledEarly
        ? '# Handoff: Delegated child settled without a result.'
        : '# Handoff: Productive tool-call budget exhausted.',
      '',
      `- Completed work: Productive calls completed: ${productiveCalls}.`,
      ...(toolLedger.length > 0
        ? [`- Tool ledger: ${toolLedger.join('; ')}`]
        : ['- Tool ledger: No productive tool completed before handoff.']),
      settledEarly
        ? '- Current state: The delegated child settled before submitting a result.'
        : '- Current state: Work tools are locked; no further productive tool calls ran.',
      '- Remaining work: A fresh child must inspect the previous handoff and continue this same step.',
      settledEarly
        ? '- Blocker: The delegated child ended without its required structured result.'
        : '- Blocker: The configured productive tool-call budget is exhausted.',
      '**Next:** Start a fresh delegated attempt for this step using the persisted handoff.',
    ].join('\n'),
  };
};

/** Returns whether a same-child completion repair may be requested safely. */
export const needsCompletionRepair = ({
  policy,
  dependencies,
}: {
  readonly policy: ChildStepPolicy;
  readonly dependencies: SubagentChildRuntimeDependencies;
}): boolean => {
  try {
    return !dependencies.fileSystem.exists(policy.resultPath);
  } catch {
    return false;
  }
};
