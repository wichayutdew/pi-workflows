import type { ChildStepPolicy } from './child-policy-types.ts';
import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';

export const COMPLETION_REPAIR_PROMPT = [
  'The delegated step settled without its required correlated result.',
  'Do not repeat completed work and do not execute work tools.',
  'Call `structured_output` exactly once, alone, with one configured outcome and the required summary, artifact, and workspace fields.',
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
