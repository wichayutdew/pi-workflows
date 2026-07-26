import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  MAX_STEP_TRACE_LOG_CHARS,
  MAX_STEP_TRACE_LOG_EVENTS,
  type SubagentTranscriptReference,
} from '../engine/state.ts';
import {
  redactStepLogText,
  redactStepLogValue,
  sanitizeStepLogText,
  stepLogLinesFromMessage,
} from '../step-log.ts';

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

export type StepTranscriptLog =
  | {
      readonly status: 'available';
      readonly lines: ReadonlyArray<string>;
      readonly truncated: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
    };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function hasSafeIdentity(reference: SubagentTranscriptReference): boolean {
  return (
    isAbsolute(reference.trustedRoot) &&
    isAbsolute(reference.sessionFile) &&
    !reference.trustedRoot.includes('\0') &&
    !reference.sessionFile.includes('\0') &&
    reference.runId.length > 0 &&
    !reference.runId.includes('\0') &&
    !reference.runId.includes('/') &&
    !reference.runId.includes('\\') &&
    reference.runId !== '.' &&
    reference.runId !== '..' &&
    Number.isSafeInteger(reference.childIndex) &&
    reference.childIndex >= 0 &&
    resolve(reference.sessionFile) ===
      resolve(
        reference.trustedRoot,
        reference.runId,
        `run-${reference.childIndex}`,
        'session.jsonl',
      )
  );
}

export {
  redactStepDetailText as redactStatusDetailText,
  redactStepLogText as redactStatusLogText,
  sanitizeStepLogText as sanitizeStatusLogText,
} from '../step-log.ts';

function transcriptEntryLines(entry: unknown): Array<string> {
  if (!isRecord(entry)) return [];
  if (entry.type === 'custom_message') {
    const customType =
      typeof entry.customType === 'string' ? entry.customType : 'custom';
    const content =
      typeof entry.content === 'string'
        ? redactStepLogText(entry.content)
        : redactStepLogValue(entry.details);
    return content
      ? [`event ${sanitizeStepLogText(customType)}\n${content}`]
      : [];
  }
  if (entry.type !== 'message' || !isRecord(entry.message)) return [];
  return stepLogLinesFromMessage(entry.message);
}

function parseTranscript(
  content: string,
  sourceTruncated: boolean,
): StepTranscriptLog {
  const lines: Array<string> = [];
  let chars = 0;
  let truncated = sourceTruncated;
  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    for (const line of transcriptEntryLines(entry)) {
      if (
        lines.length >= MAX_STEP_TRACE_LOG_EVENTS ||
        chars + line.length > MAX_STEP_TRACE_LOG_CHARS
      ) {
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length;
    }
    if (
      lines.length >= MAX_STEP_TRACE_LOG_EVENTS ||
      chars >= MAX_STEP_TRACE_LOG_CHARS
    ) {
      break;
    }
  }
  return { status: 'available', lines, truncated };
}

/**
 * Reads one child transcript through a confined, no-follow, stable prefix.
 *
 * The private child-policy user message is never rendered. Callers display
 * the separately persisted policy-envelope-free task body instead.
 */
export async function readStepTranscript(
  reference: SubagentTranscriptReference,
): Promise<StepTranscriptLog> {
  if (!hasSafeIdentity(reference)) {
    return {
      status: 'unavailable',
      reason: 'The recorded child transcript identity is invalid.',
    };
  }
  try {
    const runDirectory = resolve(reference.trustedRoot, reference.runId);
    const childDirectory = resolve(runDirectory, `run-${reference.childIndex}`);
    const [runDirectoryInfo, childDirectoryInfo] = await Promise.all([
      lstat(runDirectory),
      lstat(childDirectory),
    ]);
    if (
      runDirectoryInfo.isSymbolicLink() ||
      !runDirectoryInfo.isDirectory() ||
      childDirectoryInfo.isSymbolicLink() ||
      !childDirectoryInfo.isDirectory()
    ) {
      return {
        status: 'unavailable',
        reason:
          'The recorded child transcript directory identity is not trusted.',
      };
    }
    const inspected = await lstat(reference.sessionFile);
    if (inspected.isSymbolicLink() || !inspected.isFile()) {
      return {
        status: 'unavailable',
        reason: 'The recorded child transcript is not a regular file.',
      };
    }
    const [canonicalRoot, canonicalSession] = await Promise.all([
      realpath(reference.trustedRoot),
      realpath(reference.sessionFile),
    ]);
    const canonicalExpected = resolve(
      canonicalRoot,
      reference.runId,
      `run-${reference.childIndex}`,
      'session.jsonl',
    );
    if (
      !isWithin(canonicalRoot, canonicalSession) ||
      canonicalSession !== canonicalExpected
    ) {
      return {
        status: 'unavailable',
        reason:
          'The recorded child transcript does not match its trusted canonical identity.',
      };
    }

    const handle = await open(
      canonicalSession,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        return {
          status: 'unavailable',
          reason: 'The recorded child transcript is not readable.',
        };
      }
      const bytesToRead = Math.min(before.size, MAX_TRANSCRIPT_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const after = await handle.stat();
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        return {
          status: 'unavailable',
          reason: 'The child transcript changed while it was being read.',
        };
      }
      return parseTranscript(
        buffer.subarray(0, bytesRead).toString('utf8'),
        before.size > bytesToRead,
      );
    } finally {
      await handle.close();
    }
  } catch {
    return {
      status: 'unavailable',
      reason:
        'The recorded child transcript is missing or cannot be read safely.',
    };
  }
}
