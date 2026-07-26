import { basename } from 'node:path';
import type { BashPermission, BashRule } from '../config/types.ts';
import type { BashAuthorization } from './bash-types.ts';
import { tokenizeRestrictedCommand } from './restricted-command.ts';

const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'bash',
  'builtin',
  'command',
  'env',
  'exec',
  'fish',
  'sh',
  'time',
  'xargs',
  'zsh',
]);
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const reject = (reason: string): BashAuthorization => ({
  allowed: false,
  reason,
});

const matchesRule = (tokens: ReadonlyArray<string>, rule: BashRule): boolean =>
  tokens[0] === rule.executable &&
  rule.argsPrefix.every((expected, index) => tokens[index + 1] === expected);

/**
 * Authorizes a Bash command for a workflow step.
 *
 * @param command - Bash command text.
 * @param permission - Bash permission configured for the active step.
 * @returns The authorization decision.
 */
export const authorizeBash = (
  command: string,
  permission: BashPermission,
): BashAuthorization => {
  if (permission.mode === 'unrestricted') {
    return { allowed: true };
  }
  if (permission.mode === 'deny') {
    return reject('Bash is disabled for this workflow step');
  }

  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return reject(parsed.error);

  const executable = parsed.tokens[0] ?? '';
  if (SHELL_WRAPPERS.has(basename(executable))) {
    return reject(
      `shell wrapper "${executable}" is not allowed in restricted mode`,
    );
  }
  if (ENVIRONMENT_ASSIGNMENT.test(executable)) {
    return reject('environment assignments are not allowed in restricted mode');
  }

  const rule = permission.allow.find((candidate) =>
    matchesRule(parsed.tokens, candidate),
  );
  if (!rule) {
    return reject("command does not match this step's Bash allow-list");
  }
  return { allowed: true, tokens: [...parsed.tokens] };
};
