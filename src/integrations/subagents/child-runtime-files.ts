import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ChildStepPolicy } from './child-policy-types.ts';
import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';

const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set(['edit', 'write']);

const errorCode = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;

const pathIsInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const nearestCanonicalAncestor = (
  path: string,
  dependencies: SubagentChildRuntimeDependencies,
): string | undefined => {
  let candidate = path;
  while (true) {
    try {
      dependencies.fileSystem.inspect(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return undefined;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
      continue;
    }
    try {
      return dependencies.fileSystem.realPath(candidate);
    } catch {
      return undefined;
    }
  }
};

type VerifyChildCapabilityOptions = {
  readonly policy: ChildStepPolicy;
  readonly childAgent: string;
  readonly dependencies: SubagentChildRuntimeDependencies;
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

type RepositoryMutationOptions = {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly policy: ChildStepPolicy;
  readonly dependencies: SubagentChildRuntimeDependencies;
};

/**
 * Returns a policy error when a file mutation escapes the reviewed repository.
 */
export const repositoryMutationError = ({
  toolName,
  input,
  policy,
  dependencies,
}: RepositoryMutationOptions): string | undefined => {
  if (!policy.repositoryCwd || !FILE_MUTATION_TOOLS.has(toolName)) return;
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return `${toolName} must name a path inside the reviewed repository root`;
  }

  const candidate = resolve(dependencies.currentWorkingDirectory(), input.path);
  const root = resolve(policy.repositoryCwd);
  if (!pathIsInside(root, candidate)) {
    return `${toolName} path is outside the reviewed repository root "${policy.repositoryCwd}"`;
  }

  let canonicalRoot: string;
  try {
    if (!dependencies.fileSystem.stat(root).isDirectory()) {
      throw new Error('not a directory');
    }
    canonicalRoot = dependencies.fileSystem.realPath(root);
  } catch {
    return `reviewed repository root is not an existing directory: ${policy.repositoryCwd}`;
  }
  const canonicalAncestor = nearestCanonicalAncestor(candidate, dependencies);
  if (
    canonicalAncestor === undefined ||
    !pathIsInside(canonicalRoot, canonicalAncestor)
  ) {
    return `${toolName} path is outside the reviewed repository root "${policy.repositoryCwd}"`;
  }
  return;
};
