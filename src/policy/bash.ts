import { basename } from 'node:path';
import type { BashPermission, BashRule } from '../config/types.ts';

const UNQUOTED_SHELL_META = new Set([
  ';',
  '&',
  '|',
  '<',
  '>',
  '\n',
  '\r',
  '`',
  '$',
  '(',
  ')',
  '{',
  '}',
  '#',
  '\0',
]);
const PATHNAME_EXPANSION = new Set(['*', '?', '[', ']', '~']);
const WRAPPER_COMMANDS = new Set([
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
const READ_ONLY_EXECUTABLES = new Set([
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'stat',
  'tail',
  'wc',
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
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
];
const DANGEROUS_GIT_SHORT_OPTIONS: ReadonlyArray<{
  subcommand: string;
  option: string;
}> = [
  // `git grep -O<pager>` executes the supplied pager command.
  { subcommand: 'grep', option: '-O' },
];
const HOSTED_API_MUTATION_OPTIONS = [
  '--field',
  '--form',
  '--input',
  '--method',
  '--raw-field',
  '-F',
  '-X',
  '-f',
];

export interface BashAuthorization {
  allowed: boolean;
  reason?: string;
  tokens?: string[];
}

function reject(reason: string): BashAuthorization {
  return { allowed: false, reason };
}

/**
 * Tokenize the deliberately small shell subset accepted by restricted modes.
 * Shell operators, substitutions, expansions, and comments are rejected first.
 */
export function tokenizeRestrictedCommand(command: string): ValidationTokens {
  if (!command.trim()) return { error: 'empty Bash command' };

  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const character of command) {
    if (quote === "'") {
      if (character === '\n' || character === '\r' || character === '\0') {
        return { error: 'multiline and null characters are not allowed' };
      }
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '\n' || character === '\r' || character === '\0') {
        return { error: 'multiline and null characters are not allowed' };
      }
      if (character === '"') {
        quote = undefined;
      } else if (character === '$' || character === '`' || character === '\\') {
        return {
          error:
            'substitutions and escapes are not allowed inside double quotes',
        };
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (escaping) {
      if (character === '\n' || character === '\r' || character === '\0') {
        return { error: 'multiline and null characters are not allowed' };
      }
      token += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (UNQUOTED_SHELL_META.has(character)) {
      return {
        error:
          'shell operators, substitutions, expansions, and comments are not allowed',
      };
    }
    if (PATHNAME_EXPANSION.has(character)) {
      return {
        error: 'unquoted pathname and tilde expansion are not allowed',
      };
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaping) return { error: 'trailing Bash escape is not allowed' };
  if (quote) return { error: 'unterminated Bash quote' };
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0) return { error: 'empty Bash command' };
  return { tokens };
}

interface ValidationTokens {
  tokens?: string[];
  error?: string;
}

export interface RestrictedGitCommand {
  subcommand: string;
  subcommandIndex: number;
}

export function parseRestrictedGitCommand(
  tokens: readonly string[],
): RestrictedGitCommand | undefined {
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
}

function matchesRule(tokens: readonly string[], rule: BashRule): boolean {
  if (tokens[0] !== rule.executable) return false;
  return rule.argsPrefix.every(
    (expected, index) => tokens[index + 1] === expected,
  );
}

function hasOption(tokens: readonly string[], option: string): boolean {
  return tokens.some(
    (token) => token === option || token.startsWith(`${option}=`),
  );
}

function authorizeReadOnly(tokens: readonly string[]): BashAuthorization {
  const executable = tokens[0] ?? '';
  if (READ_ONLY_EXECUTABLES.has(executable)) {
    if (
      executable === 'rg' &&
      (hasOption(tokens, '--pre') || hasOption(tokens, '--pre-glob'))
    ) {
      return reject('rg preprocessors are not allowed in read-only mode');
    }
    return { allowed: true, tokens: [...tokens] };
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
    ({ subcommand: matchedSubcommand, option }) =>
      gitCommand.subcommand === matchedSubcommand &&
      tokens
        .slice(gitCommand.subcommandIndex + 1)
        .some((token) => token === option || token.startsWith(option)),
  );
  if (dangerousShortOption) {
    return reject(
      `git option "${dangerousShortOption.option}" is not allowed in read-only mode`,
    );
  }
  return { allowed: true, tokens: [...tokens] };
}

function usesReadOnlyPreset(tokens: readonly string[]): boolean {
  const executable = tokens[0] ?? '';
  return (
    READ_ONLY_EXECUTABLES.has(executable) ||
    (executable === 'git' &&
      READ_ONLY_GIT_SUBCOMMANDS.has(
        parseRestrictedGitCommand(tokens)?.subcommand ?? '',
      ))
  );
}

function authorizeHostedApiRead(tokens: readonly string[]): BashAuthorization {
  const executable = basename(tokens[0] ?? '');
  if ((executable !== 'gh' && executable !== 'glab') || tokens[1] !== 'api') {
    return { allowed: true, tokens: [...tokens] };
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
  if (mutationOption) {
    return reject(
      `${executable} api option "${mutationOption}" is not allowed by a static read-only rule`,
    );
  }
  return { allowed: true, tokens: [...tokens] };
}

export function authorizeBash(
  command: string,
  permission: BashPermission,
  approvedCommands: readonly string[] = [],
): BashAuthorization {
  if (
    (permission.approvedSources?.length ?? 0) > 0 &&
    approvedCommands.includes(command)
  ) {
    return { allowed: true };
  }
  if (permission.mode === 'unrestricted') {
    return { allowed: true };
  }
  if (permission.mode === 'deny') {
    return reject('Bash is disabled for this workflow step');
  }

  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return reject(parsed.error ?? 'invalid Bash command');
  const executable = parsed.tokens[0] ?? '';
  if (WRAPPER_COMMANDS.has(basename(executable))) {
    return reject(
      `shell wrapper "${executable}" is not allowed in restricted mode`,
    );
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
    return reject('environment assignments are not allowed in restricted mode');
  }

  if (permission.mode === 'read-only') {
    return authorizeReadOnly(parsed.tokens);
  }
  const rule = permission.allow.find((candidate) =>
    matchesRule(parsed.tokens ?? [], candidate),
  );
  if (!rule) {
    return reject(`command does not match this step's Bash allow-list`);
  }
  if (usesReadOnlyPreset(parsed.tokens)) {
    return authorizeReadOnly(parsed.tokens);
  }
  return authorizeHostedApiRead(parsed.tokens);
}
