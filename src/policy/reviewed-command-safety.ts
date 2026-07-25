import { basename } from 'node:path';
import { tokenizeRestrictedCommand } from './restricted-command.ts';
import { parseRestrictedGitCommand } from './restricted-git.ts';

const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'bash',
  'env',
  'exec',
  'fish',
  'sh',
  'xargs',
  'zsh',
]);
const REMOTE_EXECUTABLES: ReadonlySet<string> = new Set([
  'curl',
  'scp',
  'ssh',
  'rsync',
  'wget',
]);
const FORBIDDEN_LONG_PUSH_OPTIONS = [
  '--force',
  '--force-if-includes',
  '--force-with-lease',
  '--all',
  '--delete',
  '--mirror',
  '--prune',
  '--tags',
] as const;
const PUBLISH_EXECUTABLES: ReadonlySet<string> = new Set([
  'bun',
  'cargo',
  'npm',
  'pnpm',
  'yarn',
]);
const LOCAL_VERIFICATION_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'branch',
  'commit',
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'show',
  'status',
  'worktree',
]);

const containsPublishOperation = (tokens: ReadonlyArray<string>): boolean =>
  tokens
    .slice(1)
    .some((token) => token.length >= 3 && 'publish'.startsWith(token));

const hasDestructivePushShortOption = (token: string): boolean =>
  token.startsWith('-') &&
  !token.startsWith('--') &&
  (token.slice(1).includes('f') || token.slice(1).includes('d'));

const hasForbiddenLongPushOption = (token: string): boolean => {
  if (!token.startsWith('--') || token === '--') return false;
  const optionName = token.split('=', 1)[0] ?? token;
  return FORBIDDEN_LONG_PUSH_OPTIONS.some((option) =>
    option.startsWith(optionName),
  );
};

const hasEmptyPushRefspecSide = (token: string): boolean => {
  const separator = token.indexOf(':');
  return separator >= 0 && (separator === 0 || separator === token.length - 1);
};

/**
 * Determines whether a reviewed verification command is safe to authorize.
 *
 * @param command - Exact command extracted from an approved artifact.
 * @returns `true` for local, non-publishing verification commands.
 */
export const isSafeVerificationCommand = (command: string): boolean => {
  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return false;

  const executable = basename(parsed.tokens[0] ?? '');
  if (SHELL_WRAPPERS.has(executable) || REMOTE_EXECUTABLES.has(executable)) {
    return false;
  }

  const subcommand =
    executable === 'git'
      ? parseRestrictedGitCommand(parsed.tokens)?.subcommand
      : parsed.tokens[1];
  if (
    executable === 'git' &&
    (!subcommand || !LOCAL_VERIFICATION_GIT_SUBCOMMANDS.has(subcommand))
  ) {
    return false;
  }
  if (executable === 'gh' || executable === 'glab') return false;
  if (
    PUBLISH_EXECUTABLES.has(executable) &&
    containsPublishOperation(parsed.tokens)
  ) {
    return false;
  }
  return !(executable === 'docker' && parsed.tokens.slice(1).includes('push'));
};

const isHostedApiDelete = (tokens: ReadonlyArray<string>): boolean =>
  tokens.slice(2).some((token, index, apiTokens) => {
    const normalizedToken = token.toUpperCase();
    return (
      normalizedToken === '--METHOD=DELETE' ||
      normalizedToken === '-XDELETE' ||
      ((normalizedToken === '--METHOD' || normalizedToken === '-X') &&
        apiTokens[index + 1]?.toUpperCase() === 'DELETE')
    );
  });

/**
 * Determines whether a reviewed remote action is narrowly safe to authorize.
 *
 * @param command - Exact command extracted from an approved artifact.
 * @returns `true` for non-destructive Git pushes and hosted API writes.
 */
export const isSafeRemoteActionCommand = (command: string): boolean => {
  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return false;

  const executable = parsed.tokens[0];
  const subcommand =
    executable === 'git'
      ? parseRestrictedGitCommand(parsed.tokens)?.subcommand
      : parsed.tokens[1];
  if (executable === 'gh' || executable === 'glab') {
    return subcommand === 'api' && !isHostedApiDelete(parsed.tokens);
  }
  if (executable !== 'git' || subcommand !== 'push') return false;

  return !parsed.tokens
    .slice(1)
    .some(
      (token) =>
        hasForbiddenLongPushOption(token) ||
        token.startsWith('+') ||
        hasEmptyPushRefspecSide(token) ||
        hasDestructivePushShortOption(token),
    );
};
