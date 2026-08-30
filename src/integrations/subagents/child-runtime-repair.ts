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
  'Call `structured_output` exactly once, alone, with one configured outcome and a compact handoff.',
].join('\n');

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
