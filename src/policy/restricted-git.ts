import type { RestrictedGitCommand } from './bash-types.ts';

/**
 * Finds the Git subcommand in a tokenized restricted command.
 *
 * Only the global options deliberately supported by the policy are skipped.
 *
 * @param tokens - Tokenized Git command.
 * @returns The subcommand and its index, or `undefined` for an invalid shape.
 */
export const parseRestrictedGitCommand = (
  tokens: ReadonlyArray<string>,
): RestrictedGitCommand | undefined => {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '-C') {
      if (!tokens[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if (token === '--no-pager') {
      index += 1;
      continue;
    }
    if (!token || token.startsWith('-')) return undefined;
    return { subcommand: token, subcommandIndex: index };
  }
  return undefined;
};
