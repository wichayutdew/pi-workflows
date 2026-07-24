import { basename } from 'node:path';
import type { BashApprovalSource } from '../config/types.ts';
import {
  parseRestrictedGitCommand,
  tokenizeRestrictedCommand,
} from './bash.ts';

const SHELL_WRAPPERS = new Set([
  'bash',
  'env',
  'exec',
  'fish',
  'sh',
  'xargs',
  'zsh',
]);
const REMOTE_EXECUTABLES = new Set(['curl', 'scp', 'ssh', 'rsync', 'wget']);
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
const PUBLISH_EXECUTABLES = new Set(['bun', 'cargo', 'npm', 'pnpm', 'yarn']);
const LOCAL_VERIFICATION_GIT_SUBCOMMANDS = new Set([
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

function hasDestructivePushShortOption(token: string): boolean {
  return (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    (token.slice(1).includes('f') || token.slice(1).includes('d'))
  );
}

function hasForbiddenLongPushOption(token: string): boolean {
  if (!token.startsWith('--') || token === '--') return false;
  const optionName = token.split('=', 1)[0] ?? token;
  return FORBIDDEN_LONG_PUSH_OPTIONS.some((option) =>
    option.startsWith(optionName),
  );
}

function hasEmptyPushRefspecSide(token: string): boolean {
  const separator = token.indexOf(':');
  return separator >= 0 && (separator === 0 || separator === token.length - 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      // Markdown artifacts are normally handled by fenced JSON below.
    }
  }

  const fences = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fences)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      documents.push(JSON.parse(candidate));
    } catch {
      // Other fenced examples are not approval contracts.
    }
  }
  return documents;
}

function verificationCommands(
  value: unknown,
  role: 'worker' | 'reviewer',
): string[] {
  if (!isObject(value) || !Array.isArray(value.repositories)) return [];
  const commands: string[] = [];
  for (const repository of value.repositories) {
    if (!isObject(repository) || !Array.isArray(repository[role])) continue;
    for (const check of repository[role]) {
      if (isObject(check) && typeof check.command === 'string') {
        commands.push(check.command);
      }
    }
  }
  return commands;
}

function remoteActionCommands(value: unknown): string[] {
  if (!isObject(value) || !Array.isArray(value.actions)) return [];
  const commands: string[] = [];
  for (const action of value.actions) {
    if (
      isObject(action) &&
      action.toolName === 'bash' &&
      isObject(action.input) &&
      typeof action.input.command === 'string'
    ) {
      commands.push(action.input.command);
    }
  }
  return commands;
}

function containsPublishOperation(tokens: readonly string[]): boolean {
  return tokens
    .slice(1)
    .some((token) => token.length >= 3 && 'publish'.startsWith(token));
}

function safeVerificationCommand(command: string): boolean {
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
  if (executable === 'docker' && parsed.tokens.slice(1).includes('push')) {
    return false;
  }
  return true;
}

function safeRemoteActionCommand(command: string): boolean {
  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return false;
  const executable = parsed.tokens[0];
  const subcommand =
    executable === 'git'
      ? parseRestrictedGitCommand(parsed.tokens)?.subcommand
      : parsed.tokens[1];
  if (executable === 'gh' || executable === 'glab') {
    if (subcommand !== 'api') return false;
    return !parsed.tokens.slice(2).some((token, index, apiTokens) => {
      const upper = token.toUpperCase();
      return (
        upper === '--METHOD=DELETE' ||
        upper === '-XDELETE' ||
        ((upper === '--METHOD' || upper === '-X') &&
          apiTokens[index + 1]?.toUpperCase() === 'DELETE')
      );
    });
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
}

/**
 * Extract exact Bash capabilities from machine-readable JSON that a
 * human review gate already displayed and approved.
 */
export function extractApprovedBashCommands(
  artifact: string,
  sources: readonly BashApprovalSource[],
): string[] {
  if (!artifact.trim() || sources.length === 0) return [];
  const commands: string[] = [];
  for (const document of parseJsonDocuments(artifact)) {
    for (const source of sources) {
      if (source === 'verification-worker') {
        commands.push(
          ...verificationCommands(document, 'worker').filter(
            safeVerificationCommand,
          ),
        );
      } else if (source === 'verification-reviewer') {
        commands.push(
          ...verificationCommands(document, 'reviewer').filter(
            safeVerificationCommand,
          ),
        );
      } else {
        commands.push(
          ...remoteActionCommands(document).filter(safeRemoteActionCommand),
        );
      }
    }
  }
  return [...new Set(commands)];
}
