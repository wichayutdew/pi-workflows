import { statSync } from 'node:fs';
import { isRecord } from './reviewed-artifact.ts';
import { parseReviewedRepositoryContract } from './reviewed-repository-contract.ts';

export type ReviewedRepositoryCwdResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly kind: 'resolved';
      readonly cwd: string;
      readonly repositoryCwd: string;
      readonly bootstrapping: boolean;
    };

export type DirectoryState = 'directory' | 'missing' | 'invalid';

export type ReviewedRepositoryCwdDependencies = {
  readonly readDirectoryState: (path: string) => DirectoryState;
};

export type ResolveReviewedRepositoryCwd = (
  artifact: string,
) => ReviewedRepositoryCwdResolution;

const readDirectoryState = (path: string): DirectoryState => {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'invalid';
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'invalid';
  }
};

const invalidResolution = (
  reason: string,
): ReviewedRepositoryCwdResolution => ({
  kind: 'invalid',
  reason,
});

/**
 * Creates a reviewed-directory resolver with an injected filesystem reader.
 *
 * The injected boundary keeps contract parsing and launch-path selection
 * deterministic and independently testable.
 *
 * @param dependencies - Filesystem operations used by the resolver.
 * @returns A resolver bound to those dependencies.
 */
export const createReviewedRepositoryCwdResolver = (
  dependencies: ReviewedRepositoryCwdDependencies,
): ResolveReviewedRepositoryCwd => {
  return (artifact): ReviewedRepositoryCwdResolution => {
    const contract = parseReviewedRepositoryContract(artifact);
    if (contract.kind !== 'valid') return contract;

    const repositoryState = dependencies.readDirectoryState(
      contract.repositoryCwd,
    );
    if (repositoryState === 'directory') {
      return {
        kind: 'resolved',
        cwd: contract.repositoryCwd,
        repositoryCwd: contract.repositoryCwd,
        bootstrapping: false,
      };
    }
    if (repositoryState === 'invalid') {
      return invalidResolution(
        `Reviewed repository cwd is not an accessible directory: ${contract.repositoryCwd}`,
      );
    }
    if (!contract.sourceCwd) {
      return invalidResolution(
        'Reviewed repository target is missing and requires exactly one absolute sourceCwd',
      );
    }
    if (dependencies.readDirectoryState(contract.sourceCwd) !== 'directory') {
      return invalidResolution(
        `Reviewed repository sourceCwd is not an existing directory: ${contract.sourceCwd}`,
      );
    }
    return {
      kind: 'resolved',
      cwd: contract.sourceCwd,
      repositoryCwd: contract.repositoryCwd,
      bootstrapping: true,
    };
  };
};

/**
 * Resolves the launch directory from a reviewed repository contract.
 *
 * Malformed, ambiguous, or incomplete contracts never fall back silently.
 *
 * @param artifact - Human-reviewed artifact text.
 * @returns The resolved directory, absence, or a validation error.
 */
export const resolveReviewedRepositoryCwd = createReviewedRepositoryCwdResolver(
  { readDirectoryState },
);
