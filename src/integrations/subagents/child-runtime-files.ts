import type { ChildStepPolicy } from './child-policy-types.ts';
import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';

type VerifyChildCapabilityOptions = {
  readonly policy: ChildStepPolicy;
  readonly childAgent: string;
  readonly dependencies: SubagentChildRuntimeDependencies;
};

/**
 * Verifies that the delegated child started in the workflow run's captured
 * working directory.
 *
 * @throws When either directory cannot be resolved or they differ.
 */
export const verifyChildWorkingDirectory = (
  policy: ChildStepPolicy,
  dependencies: SubagentChildRuntimeDependencies,
): void => {
  let expected: string;
  let actual: string;
  try {
    expected = dependencies.fileSystem.realPath(policy.cwd);
    actual = dependencies.fileSystem.realPath(
      dependencies.currentWorkingDirectory(),
    );
  } catch {
    throw new Error(
      'child working directory does not match the delegated workflow policy',
    );
  }
  if (expected !== policy.cwd || actual !== expected) {
    throw new Error(
      'child working directory does not match the delegated workflow policy',
    );
  }
};

/**
 * Verifies and consumes the one-time capability for a delegated child.
 *
 * @throws When the child identity or capability is invalid.
 */
export const verifyChildCapability = ({
  policy,
  childAgent,
  dependencies,
}: VerifyChildCapabilityOptions): void => {
  if (childAgent !== policy.agent) {
    throw new Error('child agent does not match the delegated workflow policy');
  }

  let actual: string;
  try {
    actual = dependencies.fileSystem.readText(policy.capabilityPath);
  } catch {
    throw new Error('delegated workflow capability is missing');
  }
  if (!dependencies.tokensAreEqual(actual, policy.capabilityToken)) {
    throw new Error('delegated workflow capability is invalid');
  }
  dependencies.fileSystem.unlink(policy.capabilityPath);
};

type WriteChildResultOptions = {
  readonly policy: ChildStepPolicy;
  readonly result: unknown;
  readonly dependencies: SubagentChildRuntimeDependencies;
};

/**
 * Atomically writes a delegated result through injected file-system
 * operations.
 */
export const writeChildResult = ({
  policy,
  result,
  dependencies,
}: WriteChildResultOptions): void => {
  if (dependencies.fileSystem.exists(policy.resultPath)) {
    throw new Error('Delegated workflow step already produced a result');
  }

  const temporaryPath = `${policy.resultPath}.${dependencies.createUniqueId()}.tmp`;
  try {
    dependencies.fileSystem.writeExclusive(
      temporaryPath,
      JSON.stringify(result),
    );
    dependencies.fileSystem.rename(temporaryPath, policy.resultPath);
  } catch (error) {
    try {
      dependencies.fileSystem.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
};
