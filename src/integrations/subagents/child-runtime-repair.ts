import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

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
  'Use the `handoff` outcome. Call `structured_output` exactly once, alone, now.',
  'Use the approved plan and previous handoff to identify each plan item as completed, in progress, or not started.',
  'Cite evidence for completed or in-progress work and name the exact first action for the next child.',
  'If you settle without a result, the parent workflow harness composes a contextual fallback handoff from the approved plan, original request, and your prior checkpoints; it does not fabricate completed work on your behalf.',
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
