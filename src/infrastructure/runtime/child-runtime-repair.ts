import type { ChildStepPolicy } from '../../domain/index.ts';
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
    'Finish the active delegated step with its applicable configured outcome when possible; otherwise begin preparing a compact handoff for its incomplete work.',
  ].join('\n');

export const TOOL_BUDGET_HANDOFF_PROMPT = [
  'The productive tool-call budget is exhausted.',
  'Work tools are locked; do not execute further work.',
  'Call `structured_output` exactly once, alone, with the configured outcome that accurately reflects the active delegated step state.',
  'Use `handoff` only for incomplete work in the active delegated step, never for downstream workflow work.',
  'Use the active-step instructions and previous handoff to identify its completed, in-progress, and not-started work.',
  'Cite evidence for completed or in-progress work and name the exact first action for the next child to continue this active step.',
  'If you settle without a result, the parent workflow harness composes a contextual fallback handoff from available active-step context and your prior checkpoints; it does not fabricate completed work on your behalf.',
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
