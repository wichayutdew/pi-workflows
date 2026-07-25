import { isAbsolute } from 'node:path';
import {
  isRecord,
  parseJsonDocumentsWithValidity,
} from './reviewed-artifact.ts';

export type ReviewedRepositoryContract =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly kind: 'valid';
      readonly repositoryCwd: string;
      readonly sourceCwd?: string;
    };

const invalidContract = (reason: string): ReviewedRepositoryContract => ({
  kind: 'invalid',
  reason,
});

const isAbsoluteSafePath = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && !value.includes('\0');

type RepositoryDirectories = {
  readonly repositoryDirectories: ReadonlySet<string>;
  readonly sourceDirectories: ReadonlySet<string>;
};

const addRepositoryDirectories = (
  document: Readonly<Record<string, unknown>>,
  repositoryDirectories: Set<string>,
  sourceDirectories: Set<string>,
): ReviewedRepositoryContract | undefined => {
  if (
    !Array.isArray(document.repositories) ||
    document.repositories.length === 0
  ) {
    return invalidContract(
      'Reviewed repository contract must contain a non-empty repositories array',
    );
  }

  for (const repository of document.repositories) {
    if (!isRecord(repository)) {
      return invalidContract(
        'Reviewed repository contract contains a malformed repository entry',
      );
    }
    if (!isAbsoluteSafePath(repository.cwd)) {
      return invalidContract(
        'Reviewed repository contract repository cwd must be an absolute path',
      );
    }
    repositoryDirectories.add(repository.cwd);

    if ('sourceCwd' in repository) {
      if (!isAbsoluteSafePath(repository.sourceCwd)) {
        return invalidContract(
          'Reviewed repository contract sourceCwd must be an absolute path',
        );
      }
      sourceDirectories.add(repository.sourceCwd);
    }
  }
  return undefined;
};

const collectRepositoryDirectories = (
  documents: ReadonlyArray<unknown>,
): RepositoryDirectories | ReviewedRepositoryContract => {
  const repositoryDirectories = new Set<string>();
  const sourceDirectories = new Set<string>();

  for (const document of documents) {
    if (!isRecord(document) || !('repositories' in document)) continue;
    const error = addRepositoryDirectories(
      document,
      repositoryDirectories,
      sourceDirectories,
    );
    if (error) return error;
  }
  return { repositoryDirectories, sourceDirectories };
};

/**
 * Parses and validates the repository-directory portion of a reviewed artifact.
 *
 * This function is the pure validation core; filesystem availability is
 * resolved separately.
 *
 * @param artifact - Human-reviewed artifact text.
 * @returns A validated repository contract, absence, or validation error.
 */
export const parseReviewedRepositoryContract = (
  artifact: string,
): ReviewedRepositoryContract => {
  const parsed = parseJsonDocumentsWithValidity(artifact);
  const hasRepositoryContract = parsed.documents.some(
    (document) => isRecord(document) && 'repositories' in document,
  );
  if (!hasRepositoryContract) {
    return parsed.hasMalformedCandidate
      ? invalidContract('Reviewed repository contract contains malformed JSON')
      : { kind: 'none' };
  }

  const collected = collectRepositoryDirectories(parsed.documents);
  if ('kind' in collected) return collected;
  if (parsed.hasMalformedCandidate) {
    return invalidContract(
      'Reviewed repository contract contains malformed JSON',
    );
  }
  if (collected.repositoryDirectories.size !== 1) {
    return invalidContract(
      'Reviewed repository contract is ambiguous: expected exactly one repository cwd',
    );
  }
  if (collected.sourceDirectories.size > 1) {
    return invalidContract(
      'Reviewed repository contract is ambiguous: expected at most one sourceCwd',
    );
  }

  const [repositoryCwd] = collected.repositoryDirectories;
  if (!repositoryCwd) {
    return invalidContract(
      'Reviewed repository contract is ambiguous: expected exactly one repository cwd',
    );
  }
  const [sourceCwd] = collected.sourceDirectories;
  return {
    kind: 'valid',
    repositoryCwd,
    ...(sourceCwd ? { sourceCwd } : {}),
  };
};
