import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  DelegationReplayAudit,
  DelegationReplayExpectation,
  SessionTail,
  SubagentSessionIdentity,
  ToolFailureDiagnostic,
} from './diagnostic-types.ts';
import { parseFailureTranscript } from './failure-transcript.ts';
import { parseToolFailureDiagnostic } from './failure-correlation.ts';
import { parseDelegationReplayAudit } from './replay-audit.ts';

const SESSION_FILE_NAME = 'session.jsonl';
const SESSION_RUN_DIRECTORY = /^run-\d+$/;
const SESSION_FILE_SUFFIX = '.jsonl';
const MAX_SESSION_TAIL_BYTES = 1024 * 1024;

export type SubagentDiagnosticPathInspection = {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
};

export type SubagentDiagnosticFileSnapshot =
  SubagentDiagnosticPathInspection & {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number;
    readonly mtimeMs: number;
  };

export type SubagentDiagnosticFileHandle = {
  readonly stat: () => Promise<SubagentDiagnosticFileSnapshot>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
};

export type SubagentDiagnosticFileSystem = {
  readonly inspect: (path: string) => Promise<SubagentDiagnosticPathInspection>;
  readonly realPath: (path: string) => Promise<string>;
  readonly openReadOnlyNoFollow: (
    path: string,
  ) => Promise<SubagentDiagnosticFileHandle>;
};

export type SubagentDiagnosticDependencies = {
  readonly fileSystem: SubagentDiagnosticFileSystem;
};

export type CompletedDelegationTranscriptAudit =
  | {
      readonly verified: true;
      readonly warning?: string;
    }
  | {
      readonly verified: false;
      readonly reason: string;
    };

const DEFAULT_DIAGNOSTIC_DEPENDENCIES = {
  fileSystem: {
    inspect: lstat,
    realPath: realpath,
    openReadOnlyNoFollow: (path: string) =>
      open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  },
} as const satisfies SubagentDiagnosticDependencies;

const isSessionFilePath = (path: string): boolean =>
  isAbsolute(path) &&
  !path.includes('\0') &&
  basename(path) === SESSION_FILE_NAME &&
  SESSION_RUN_DIRECTORY.test(basename(dirname(path)));

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const isValidSessionIdentity = (identity: SubagentSessionIdentity): boolean =>
  identity.runId.length > 0 &&
  !identity.runId.includes('\0') &&
  basename(identity.runId) === identity.runId &&
  identity.runId !== '.' &&
  identity.runId !== '..' &&
  Number.isSafeInteger(identity.childIndex) &&
  identity.childIndex >= 0;

const readStableTail = async (
  handle: SubagentDiagnosticFileHandle,
): Promise<SessionTail | undefined> => {
  const opened = await handle.stat();
  if (!opened.isFile()) return undefined;

  const bytesToRead = Math.min(opened.size, MAX_SESSION_TAIL_BYTES);
  if (bytesToRead === 0) return { content: '', truncated: false };

  const start = opened.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
  const afterRead = await handle.stat();
  const didFileChange =
    afterRead.dev !== opened.dev ||
    afterRead.ino !== opened.ino ||
    afterRead.size !== opened.size ||
    afterRead.mtimeMs !== opened.mtimeMs;
  if (didFileChange) return undefined;

  let content = buffer.subarray(0, bytesRead).toString('utf8');
  if (start > 0) {
    const firstNewline = content.indexOf('\n');
    content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
  }
  return { content, truncated: start > 0 };
};

type ReadContainedSessionTailOptions = {
  readonly sessionFile: string;
  readonly trustedRoot: string;
  readonly identity: SubagentSessionIdentity;
  readonly dependencies: SubagentDiagnosticDependencies;
};

const readContainedSessionTail = async ({
  sessionFile,
  trustedRoot,
  identity,
  dependencies,
}: ReadContainedSessionTailOptions): Promise<SessionTail | undefined> => {
  const expectedSessionFile = resolve(
    trustedRoot,
    identity.runId,
    `run-${identity.childIndex}`,
    SESSION_FILE_NAME,
  );
  if (
    !isSessionFilePath(sessionFile) ||
    !isAbsolute(trustedRoot) ||
    trustedRoot.includes('\0') ||
    !pathIsWithin(trustedRoot, sessionFile) ||
    !isValidSessionIdentity(identity) ||
    resolve(sessionFile) !== expectedSessionFile
  ) {
    return undefined;
  }

  const runDirectory = resolve(trustedRoot, identity.runId);
  const childDirectory = resolve(runDirectory, `run-${identity.childIndex}`);
  const resolvedSessionFile = resolve(sessionFile);
  const [runDirectoryInfo, childDirectoryInfo, inspected] = await Promise.all([
    dependencies.fileSystem.inspect(runDirectory),
    dependencies.fileSystem.inspect(childDirectory),
    dependencies.fileSystem.inspect(resolvedSessionFile),
  ]);
  if (
    runDirectoryInfo.isSymbolicLink() ||
    !runDirectoryInfo.isDirectory() ||
    childDirectoryInfo.isSymbolicLink() ||
    !childDirectoryInfo.isDirectory() ||
    inspected.isSymbolicLink() ||
    !inspected.isFile()
  ) {
    return undefined;
  }

  const [canonicalRoot, canonicalSessionFile] = await Promise.all([
    dependencies.fileSystem.realPath(trustedRoot),
    dependencies.fileSystem.realPath(resolvedSessionFile),
  ]);
  const canonicalExpectedSessionFile = resolve(
    canonicalRoot,
    identity.runId,
    `run-${identity.childIndex}`,
    SESSION_FILE_NAME,
  );
  if (
    !pathIsWithin(canonicalRoot, canonicalSessionFile) ||
    canonicalSessionFile !== canonicalExpectedSessionFile
  ) {
    return undefined;
  }

  const handle =
    await dependencies.fileSystem.openReadOnlyNoFollow(canonicalSessionFile);
  try {
    return await readStableTail(handle);
  } finally {
    await handle.close();
  }
};

/**
 * Derives the trusted pi-subagents session root beside a parent session file.
 */
export const deriveSubagentSessionRoot = (
  parentSessionFile: string | undefined,
): string | undefined => {
  if (
    !parentSessionFile ||
    !isAbsolute(parentSessionFile) ||
    parentSessionFile.includes('\0')
  ) {
    return undefined;
  }
  const parentName = basename(parentSessionFile);
  if (
    !parentName.endsWith(SESSION_FILE_SUFFIX) ||
    parentName === SESSION_FILE_SUFFIX
  ) {
    return undefined;
  }
  return join(
    dirname(parentSessionFile),
    parentName.slice(0, -SESSION_FILE_SUFFIX.length),
  );
};

/**
 * Reads and correlates a tool failure from a confined child session file.
 *
 * File-system operations are dependency-injected for deterministic use.
 */
export const readToolFailureDiagnostic = async (
  sessionFile: string | undefined,
  trustedRoot: string | undefined,
  identity: SubagentSessionIdentity | undefined,
  expectedTool?: string,
  terminalError?: string,
  dependencies: SubagentDiagnosticDependencies = DEFAULT_DIAGNOSTIC_DEPENDENCIES,
): Promise<ToolFailureDiagnostic | undefined> => {
  if (!sessionFile || !trustedRoot || !identity) return undefined;
  try {
    const tail = await readContainedSessionTail({
      sessionFile,
      trustedRoot,
      identity,
      dependencies,
    });
    return parseToolFailureDiagnostic(
      tail?.content ?? '',
      expectedTool,
      terminalError,
      tail?.truncated !== true,
    );
  } catch {
    return undefined;
  }
};

/**
 * Proves that a completed child transcript ends at one successful structured
 * result and contains no later watchdog blocker.
 */
export const auditCompletedDelegationTranscript = async (
  sessionFile: string | undefined,
  trustedRoot: string | undefined,
  identity: SubagentSessionIdentity | undefined,
  dependencies: SubagentDiagnosticDependencies = DEFAULT_DIAGNOSTIC_DEPENDENCIES,
): Promise<CompletedDelegationTranscriptAudit> => {
  if (!sessionFile || !trustedRoot || !identity) {
    return {
      verified: false,
      reason: 'completed response has no trusted child transcript identity',
    };
  }
  try {
    const tail = await readContainedSessionTail({
      sessionFile,
      trustedRoot,
      identity,
      dependencies,
    });
    if (!tail) {
      return {
        verified: false,
        reason: 'completed child transcript is missing, unstable, or untrusted',
      };
    }
    const parsed = parseFailureTranscript(tail.content);
    const completion = parsed.successfulCompletions.at(-1);
    if (!completion) {
      return {
        verified: false,
        reason:
          'completed child transcript does not contain a successful structured_output result',
      };
    }
    const warning = parsed.transcriptWarnings.find(
      (candidate) => candidate.order > completion.order,
    );
    if (warning) return { verified: true, warning: warning.content };
    if (
      !parsed.hasValidFalsePositiveProof ||
      completion.order !== parsed.lastInteractionOrder
    ) {
      return {
        verified: false,
        reason:
          'completed child transcript has malformed or later terminal interactions',
      };
    }
    return { verified: true };
  } catch {
    return {
      verified: false,
      reason: 'completed child transcript could not be read safely',
    };
  }
};

/**
 * Reads and audits replay safety from a confined child session file.
 *
 * File-system operations are dependency-injected for deterministic use.
 */
export const readDelegationReplayAudit = async (
  sessionFile: string | undefined,
  trustedRoot: string | undefined,
  identity: SubagentSessionIdentity | undefined,
  expectation: DelegationReplayExpectation,
  dependencies: SubagentDiagnosticDependencies = DEFAULT_DIAGNOSTIC_DEPENDENCIES,
): Promise<DelegationReplayAudit | undefined> => {
  if (!sessionFile || !trustedRoot || !identity) return undefined;
  try {
    const tail = await readContainedSessionTail({
      sessionFile,
      trustedRoot,
      identity,
      dependencies,
    });
    return tail
      ? parseDelegationReplayAudit(tail.content, expectation, !tail.truncated)
      : undefined;
  } catch {
    return undefined;
  }
};
