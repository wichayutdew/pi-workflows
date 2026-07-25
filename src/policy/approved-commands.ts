import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
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

interface ParsedJsonDocuments {
  documents: unknown[];
  malformedCandidate: boolean;
}

function parseJsonDocumentsWithValidity(text: string): ParsedJsonDocuments {
  const documents: unknown[] = [];
  let malformedCandidate = false;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      documents.push(JSON.parse(trimmed));
    } catch {
      malformedCandidate = true;
    }
  }

  const fences = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(fences)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      documents.push(JSON.parse(candidate));
    } catch {
      malformedCandidate = true;
    }
  }
  return { documents, malformedCandidate };
}

function parseJsonDocuments(text: string): unknown[] {
  return parseJsonDocumentsWithValidity(text).documents;
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

function malformedBunInstallReason(command: string): string | undefined {
  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return undefined;
  const executable = basename(parsed.tokens[0] ?? '');
  if (executable !== 'bun') return undefined;

  const installIndex = parsed.tokens.indexOf('install', 1);
  if (installIndex <= 1) return undefined;
  const optionsBeforeInstall = parsed.tokens.slice(1, installIndex);
  if (
    !optionsBeforeInstall.some(
      (token) => token === '--cwd' || token.startsWith('--cwd='),
    )
  ) {
    return undefined;
  }

  return [
    `Invalid Bun install command: ${JSON.stringify(command)}.`,
    '`--cwd` appears before `install`, so Bun interprets `install` as a package script.',
    'Use `bun install --cwd <absolute-cwd> --frozen-lockfile`, preserving the reviewed path and any other intended install flags, then resubmit the plan.',
  ].join(' ');
}

/**
 * Reject known command-shape mistakes before a human is asked to approve an
 * execution contract. Agents still diagnose arbitrary runtime failures; these
 * deterministic checks prevent previously observed parser traps from escaping
 * into an approved handoff.
 */
export function reviewedCommandShapeError(
  artifact: string,
): string | undefined {
  for (const document of parseJsonDocuments(artifact)) {
    for (const role of ['worker', 'reviewer'] as const) {
      for (const command of verificationCommands(document, role)) {
        const reason = malformedBunInstallReason(command);
        if (reason) return reason;
      }
    }
  }
  return undefined;
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

export type ReviewedRepositoryCwdResolution =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'resolved';
      cwd: string;
      repositoryCwd: string;
      bootstrapping: boolean;
    };

type DirectoryState = 'directory' | 'missing' | 'invalid';

function directoryState(path: string): DirectoryState {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'invalid';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'invalid';
  }
}

function invalidRepositoryCwd(reason: string): ReviewedRepositoryCwdResolution {
  return { kind: 'invalid', reason };
}

/**
 * Resolve a reviewed repository launch directory without silently falling
 * back when a repository contract is malformed, ambiguous, or incomplete.
 */
export function resolveReviewedRepositoryCwd(
  artifact: string,
): ReviewedRepositoryCwdResolution {
  const parsed = parseJsonDocumentsWithValidity(artifact);
  const directories = new Set<string>();
  const sourceDirectories = new Set<string>();
  let hasRepositoryContract = false;
  for (const document of parsed.documents) {
    if (!isObject(document) || !('repositories' in document)) continue;
    hasRepositoryContract = true;
    if (
      !Array.isArray(document.repositories) ||
      document.repositories.length === 0
    ) {
      return invalidRepositoryCwd(
        'Reviewed repository contract must contain a non-empty repositories array',
      );
    }
    for (const repository of document.repositories) {
      if (!isObject(repository)) {
        return invalidRepositoryCwd(
          'Reviewed repository contract contains a malformed repository entry',
        );
      }
      if (
        typeof repository.cwd !== 'string' ||
        !isAbsolute(repository.cwd) ||
        repository.cwd.includes('\0')
      ) {
        return invalidRepositoryCwd(
          'Reviewed repository contract repository cwd must be an absolute path',
        );
      }
      directories.add(repository.cwd);
      if ('sourceCwd' in repository) {
        if (
          typeof repository.sourceCwd !== 'string' ||
          !isAbsolute(repository.sourceCwd) ||
          repository.sourceCwd.includes('\0')
        ) {
          return invalidRepositoryCwd(
            'Reviewed repository contract sourceCwd must be an absolute path',
          );
        }
        sourceDirectories.add(repository.sourceCwd);
      }
    }
  }

  if (!hasRepositoryContract) {
    return parsed.malformedCandidate
      ? invalidRepositoryCwd(
          'Reviewed repository contract contains malformed JSON',
        )
      : { kind: 'none' };
  }
  if (parsed.malformedCandidate) {
    return invalidRepositoryCwd(
      'Reviewed repository contract contains malformed JSON',
    );
  }
  if (directories.size !== 1) {
    return invalidRepositoryCwd(
      'Reviewed repository contract is ambiguous: expected exactly one repository cwd',
    );
  }
  if (sourceDirectories.size > 1) {
    return invalidRepositoryCwd(
      'Reviewed repository contract is ambiguous: expected at most one sourceCwd',
    );
  }

  const repositoryCwd = directories.values().next().value as string;
  const repositoryState = directoryState(repositoryCwd);
  if (repositoryState === 'directory') {
    return {
      kind: 'resolved',
      cwd: repositoryCwd,
      repositoryCwd,
      bootstrapping: false,
    };
  }
  if (repositoryState === 'invalid') {
    return invalidRepositoryCwd(
      `Reviewed repository cwd is not an accessible directory: ${repositoryCwd}`,
    );
  }
  if (sourceDirectories.size !== 1) {
    return invalidRepositoryCwd(
      'Reviewed repository target is missing and requires exactly one absolute sourceCwd',
    );
  }

  const sourceCwd = sourceDirectories.values().next().value as string;
  if (directoryState(sourceCwd) !== 'directory') {
    return invalidRepositoryCwd(
      `Reviewed repository sourceCwd is not an existing directory: ${sourceCwd}`,
    );
  }
  return {
    kind: 'resolved',
    cwd: sourceCwd,
    repositoryCwd,
    bootstrapping: true,
  };
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

/**
 * Keep only commands that occur in both the human-approved artifact and the
 * latest completed-step handoff. A child may narrow reviewed authority, but
 * its unreviewed output can never add a Bash capability.
 */
export function narrowApprovedBashCommands(
  artifact: string,
  handoff: string,
  sources: readonly BashApprovalSource[],
): string[] {
  const approved = extractApprovedBashCommands(artifact, sources);
  if (approved.length === 0) return [];
  const retained = new Set(extractApprovedBashCommands(handoff, sources));
  return approved.filter((command) => retained.has(command));
}
