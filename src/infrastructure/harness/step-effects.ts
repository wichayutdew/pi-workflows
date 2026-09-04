import type {
  WorkflowRun,
  WorkflowStep,
  WorkflowStepResult,
} from '../../domain/index.ts';
import type { RunStepEffects } from '../../function/index.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';

type StepEffectDependencies = Pick<
  WorkflowHarnessDependencies,
  'resolveWorkspaceDirectory'
>;

const boundWorkspaceCwd = (run: WorkflowRun): string | undefined => {
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    const cwd = run.history[index]?.workspaceCwd;
    if (cwd) return cwd;
  }
  return undefined;
};

/**
 * Validates declarative effects carried by a structured step result.
 *
 * No prompt text, summary, artifact, command, or repository convention is
 * interpreted here.
 */
export function resolveStepEffects(
  run: WorkflowRun,
  step: WorkflowStep,
  result: WorkflowStepResult,
  dependencies: StepEffectDependencies,
): RunStepEffects {
  const shouldBind = step.workspace?.bindOn.includes(result.outcome) ?? false;
  if (shouldBind && !result.workspace) {
    throw new Error(
      `step outcome "${result.outcome}" requires a workspace result`,
    );
  }
  if (!shouldBind && result.workspace) {
    throw new Error(
      `step outcome "${result.outcome}" is not allowed to bind a workspace`,
    );
  }
  if (!result.workspace || !step.workspace) return {};
  const startCwd = run.startCwd ?? run.cwd;
  if (!startCwd) {
    throw new Error(
      'workflow run has no starting directory for workspace validation',
    );
  }

  const workspaceCwd = dependencies.resolveWorkspaceDirectory({
    candidateCwd: result.workspace.cwd,
    startCwd,
    allowedRoots: step.workspace.allowedRoots,
  });
  const existingCwd = boundWorkspaceCwd(run);
  if (existingCwd && existingCwd !== workspaceCwd) {
    throw new Error(`workflow workspace is already bound to "${existingCwd}"`);
  }
  return { workspaceCwd };
}
