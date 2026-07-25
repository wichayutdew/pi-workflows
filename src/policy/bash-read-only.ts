import { basename } from 'node:path';
import type { BashAuthorization } from './bash-types.ts';
import { parseRestrictedGitCommand } from './restricted-git.ts';

const READ_ONLY_EXECUTABLES: ReadonlySet<string> = new Set([
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'stat',
  'tail',
  'wc',
]);
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
]);
const DANGEROUS_GIT_OPTIONS = [
  '--config-env',
  '--exec',
  '--ext-diff',
  '--open-files-in-pager',
  '--output',
  '--textconv',
] as const;
const DANGEROUS_GIT_SHORT_OPTIONS = [
  // `git grep -O<pager>` executes the supplied pager command.
  { subcommand: 'grep', option: '-O' },
] as const;
const HOSTED_API_MUTATION_OPTIONS = [
  '--field',
  '--form',
  '--input',
  '--method',
  '--raw-field',
  '-F',
  '-X',
  '-f',
] as const;

const reject = (reason: string): BashAuthorization => ({
  allowed: false,
  reason,
});

const allow = (tokens: ReadonlyArray<string>): BashAuthorization => ({
  allowed: true,
  tokens: [...tokens],
});

const hasOption = (tokens: ReadonlyArray<string>, option: string): boolean =>
  tokens.some((token) => token === option || token.startsWith(`${option}=`));

/**
 * Authorizes a tokenized command against the static read-only Bash preset.
 *
 * @param tokens - Restricted command tokens.
 * @returns The authorization decision.
 */
export const authorizeReadOnlyBash = (
  tokens: ReadonlyArray<string>,
): BashAuthorization => {
  const executable = tokens[0] ?? '';
  if (READ_ONLY_EXECUTABLES.has(executable)) {
    const hasRipgrepPreprocessor =
      executable === 'rg' &&
      (hasOption(tokens, '--pre') || hasOption(tokens, '--pre-glob'));
    return hasRipgrepPreprocessor
      ? reject('rg preprocessors are not allowed in read-only mode')
      : allow(tokens);
  }

  if (executable !== 'git') {
    return reject(`"${executable}" is not in the read-only Bash preset`);
  }

  const gitCommand = parseRestrictedGitCommand(tokens);
  if (!gitCommand || !READ_ONLY_GIT_SUBCOMMANDS.has(gitCommand.subcommand)) {
    return reject(
      `git subcommand "${gitCommand?.subcommand ?? ''}" is not read-only`,
    );
  }

  const dangerousOption = DANGEROUS_GIT_OPTIONS.find((option) =>
    hasOption(tokens, option),
  );
  if (dangerousOption) {
    return reject(
      `git option "${dangerousOption}" is not allowed in read-only mode`,
    );
  }

  const dangerousShortOption = DANGEROUS_GIT_SHORT_OPTIONS.find(
    ({ subcommand, option }) =>
      gitCommand.subcommand === subcommand &&
      tokens
        .slice(gitCommand.subcommandIndex + 1)
        .some((token) => token === option || token.startsWith(option)),
  );
  return dangerousShortOption
    ? reject(
        `git option "${dangerousShortOption.option}" is not allowed in read-only mode`,
      )
    : allow(tokens);
};

/**
 * Reports whether a tokenized command belongs to the read-only preset.
 *
 * @param tokens - Restricted command tokens.
 * @returns `true` when the read-only preset owns the command.
 */
export const usesReadOnlyBashPreset = (
  tokens: ReadonlyArray<string>,
): boolean => {
  const executable = tokens[0] ?? '';
  return (
    READ_ONLY_EXECUTABLES.has(executable) ||
    (executable === 'git' &&
      READ_ONLY_GIT_SUBCOMMANDS.has(
        parseRestrictedGitCommand(tokens)?.subcommand ?? '',
      ))
  );
};

/**
 * Prevents mutation flags in allow-listed GitHub and GitLab API reads.
 *
 * @param tokens - Restricted command tokens.
 * @returns The authorization decision.
 */
export const authorizeHostedApiRead = (
  tokens: ReadonlyArray<string>,
): BashAuthorization => {
  const executable = basename(tokens[0] ?? '');
  if ((executable !== 'gh' && executable !== 'glab') || tokens[1] !== 'api') {
    return allow(tokens);
  }

  const mutationOption = HOSTED_API_MUTATION_OPTIONS.find((option) =>
    tokens
      .slice(2)
      .some(
        (token) =>
          token === option ||
          token.startsWith(`${option}=`) ||
          (option.length === 2 && token.startsWith(option)),
      ),
  );
  return mutationOption
    ? reject(
        `${executable} api option "${mutationOption}" is not allowed by a static read-only rule`,
      )
    : allow(tokens);
};
