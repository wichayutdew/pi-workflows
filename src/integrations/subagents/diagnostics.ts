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
import { authorizeBash } from '../../policy/bash.ts';

const SESSION_FILE_NAME = 'session.jsonl';
const SESSION_RUN_DIRECTORY = /^run-\d+$/;
const SESSION_FILE_SUFFIX = '.jsonl';
const MAX_SESSION_TAIL_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_FIELD_CHARS = 1_600;
const TRUNCATION_MARKER = '… [truncated] …';
const REPLAY_SAFE_TOOLS = new Set([
  'find',
  'grep',
  'ls',
  'read',
  'structured_output',
]);
const PRE_EXECUTION_BASH_FAILURES = [
  'command does not match this step',
  'environment assignments are not allowed',
  'not enabled by subagent',
  'shell operators, substitutions, expansions, and comments are not allowed',
  'shell wrapper',
  'substitutions and escapes are not allowed inside double quotes',
  'trailing bash escape is not allowed',
  'unterminated bash quote',
  'unquoted pathname and tilde expansion are not allowed',
] as const;

export interface ToolFailureDiagnostic {
  tool: string;
  call?: string;
  output?: string;
  replaySafe?: true;
  completionAfterFailure?: true;
  completionValue?: Record<string, unknown>;
  correlation?: 'latest-before-completion';
}

export interface SubagentSessionIdentity {
  runId: string;
  childIndex: number;
}

interface RecordedToolCall {
  id: string;
  order: number;
  tool: string;
  call?: string;
  completionValue?: Record<string, unknown>;
}

interface RecordedToolFailure extends ToolFailureDiagnostic {
  callId?: string;
  order: number;
}

interface RecordedCompletion {
  order: number;
  value: Record<string, unknown>;
}

interface SessionTail {
  content: string;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_FIELD_CHARS) return value;
  const available = MAX_DIAGNOSTIC_FIELD_CHARS - TRUNCATION_MARKER.length - 2;
  const startLength = Math.ceil(available / 2);
  const endLength = Math.floor(available / 2);
  return `${value.slice(0, startLength)}\n${TRUNCATION_MARKER}\n${value.slice(-endLength)}`;
}

function textContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
        ? [item.text]
        : [],
    )
    .join('\n')
    .trim();
  return text ? bounded(text) : undefined;
}

function toolCallText(
  tool: string,
  argumentsValue: unknown,
): string | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  if (tool === 'bash') {
    const command = argumentsValue.command ?? argumentsValue.cmd;
    if (typeof command === 'string' && command.trim()) {
      return bounded(command.trim());
    }
  }
  return bounded(JSON.stringify(argumentsValue));
}

export function failedToolName(error: string | undefined): string | undefined {
  return error?.match(/\b([a-z][\w-]*) failed(?:\s*\(|:)/i)?.[1];
}

export function parseToolFailureDiagnostic(
  transcript: string,
  expectedTool?: string,
  terminalError?: string,
  allowCompletionProof = true,
): ToolFailureDiagnostic | undefined {
  const calls = new Map<string, RecordedToolCall>();
  const recordedCalls: RecordedToolCall[] = [];
  const diagnostics: RecordedToolFailure[] = [];
  const successfulCompletions: RecordedCompletion[] = [];
  let lastInteractionOrder = 0;
  let order = 0;

  for (const line of transcript.split('\n')) {
    order += 1;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'message') continue;
    const message = entry.message;
    if (!isRecord(message)) continue;

    if (message.role === 'assistant' && Array.isArray(message.content)) {
      lastInteractionOrder = order;
      const toolCalls = message.content.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) &&
          item.type === 'toolCall' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string',
      );
      for (const item of message.content) {
        if (
          !isRecord(item) ||
          item.type !== 'toolCall' ||
          typeof item.id !== 'string' ||
          typeof item.name !== 'string'
        ) {
          continue;
        }
        const call = toolCallText(item.name, item.arguments);
        const completionValue =
          item.name === 'structured_output' && toolCalls.length === 1
            ? structuredCompletionValue(item.arguments)
            : undefined;
        const recordedCall: RecordedToolCall = {
          id: item.id,
          order,
          tool: item.name,
          ...(call ? { call } : {}),
          ...(completionValue ? { completionValue } : {}),
        };
        calls.set(item.id, recordedCall);
        recordedCalls.push(recordedCall);
      }
      continue;
    }

    if (message.role !== 'toolResult' || typeof message.toolName !== 'string') {
      continue;
    }
    lastInteractionOrder = order;
    const recorded =
      typeof message.toolCallId === 'string'
        ? calls.get(message.toolCallId)
        : undefined;
    const callMatchesResult = recorded?.tool === message.toolName;
    if (
      message.toolName === 'structured_output' &&
      message.isError === false &&
      callMatchesResult &&
      recorded?.completionValue
    ) {
      successfulCompletions.push({
        order,
        value: recorded.completionValue,
      });
    }
    if (message.isError !== true) continue;
    const output = textContent(message.content);
    const diagnostic: ToolFailureDiagnostic = {
      tool: message.toolName,
      ...(callMatchesResult && recorded.call ? { call: recorded.call } : {}),
      ...(output ? { output } : {}),
    };
    diagnostics.push({
      ...diagnostic,
      ...(callMatchesResult && typeof message.toolCallId === 'string'
        ? { callId: message.toolCallId }
        : {}),
      order,
    });
  }

  const matchingTool = (diagnostic: RecordedToolFailure): boolean =>
    expectedTool === undefined ||
    diagnostic.tool.toLowerCase() === expectedTool.toLowerCase();
  let selected: RecordedToolFailure | undefined;
  if (terminalError) {
    selected = latestMatching(
      diagnostics,
      (diagnostic) =>
        matchingTool(diagnostic) &&
        diagnosticMatchesTerminalError(diagnostic, terminalError),
    );
    if (!selected) {
      const fallback = latestMatching(diagnostics, matchingTool);
      const latestFailureOrder = diagnostics.at(-1)?.order;
      if (
        fallback &&
        latestFailureOrder !== undefined &&
        finalCompletion(
          successfulCompletions,
          latestFailureOrder,
          lastInteractionOrder,
          allowCompletionProof,
        )
      ) {
        return publicDiagnostic(
          fallback,
          diagnostics,
          recordedCalls,
          successfulCompletions,
          lastInteractionOrder,
          allowCompletionProof,
          'latest-before-completion',
        );
      }
    }
  } else {
    selected = latestMatching(diagnostics, matchingTool);
  }
  return selected
    ? publicDiagnostic(
        selected,
        diagnostics,
        recordedCalls,
        successfulCompletions,
        lastInteractionOrder,
        allowCompletionProof,
      )
    : undefined;
}

function structuredCompletionValue(
  argumentsValue: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(argumentsValue)) return undefined;
  if (
    Object.keys(argumentsValue).length !== 1 ||
    !Object.hasOwn(argumentsValue, 'value') ||
    !isRecord(argumentsValue.value)
  ) {
    return undefined;
  }
  return argumentsValue.value;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function comparableFragments(value: string): string[] {
  const normalizedValue = normalized(value);
  const lines = value
    .split(/\r?\n/)
    .map(normalized)
    .filter((line) => line.length >= 8);
  return [...new Set([normalizedValue, ...lines])].filter(
    (fragment) => fragment.length >= 8,
  );
}

function diagnosticMatchesTerminalError(
  diagnostic: ToolFailureDiagnostic,
  terminalError: string,
): boolean {
  if (!diagnostic.output) return false;
  const detail =
    terminalError.match(
      /\b[a-z][\w-]* failed(?:\s*\([^)]*\))?\s*:\s*([\s\S]+)/i,
    )?.[1] ?? terminalError;
  const outputFragments = comparableFragments(diagnostic.output);
  const errorFragments = comparableFragments(`${terminalError}\n${detail}`);
  return outputFragments.some((output) =>
    errorFragments.some(
      (error) => output.includes(error) || error.includes(output),
    ),
  );
}

function latestMatching(
  diagnostics: RecordedToolFailure[],
  predicate: (diagnostic: RecordedToolFailure) => boolean,
): RecordedToolFailure | undefined {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index];
    if (diagnostic && predicate(diagnostic)) return diagnostic;
  }
  return undefined;
}

function preExecutionBashFailure(output: string | undefined): boolean {
  if (!output) return false;
  const normalizedOutput = output.toLowerCase();
  return PRE_EXECUTION_BASH_FAILURES.some((fragment) =>
    normalizedOutput.includes(fragment),
  );
}

function replaySafeToolCall(
  call: RecordedToolCall,
  diagnostics: RecordedToolFailure[],
): boolean {
  const tool = call.tool.toLowerCase();
  if (REPLAY_SAFE_TOOLS.has(tool)) return true;
  if (tool !== 'bash' || !call.call) return false;
  if (
    authorizeBash(call.call, { mode: 'read-only', allow: [] }).allowed === true
  ) {
    return true;
  }
  const failure = diagnostics.find(
    (diagnostic) => diagnostic.callId === call.id,
  );
  return preExecutionBashFailure(failure?.output);
}

function transcriptReplaySafe(
  calls: RecordedToolCall[],
  diagnostics: RecordedToolFailure[],
  completeTranscript: boolean,
): boolean {
  return (
    completeTranscript &&
    calls.length > 0 &&
    calls.every((call) => replaySafeToolCall(call, diagnostics))
  );
}

function publicDiagnostic(
  diagnostic: RecordedToolFailure,
  diagnostics: RecordedToolFailure[],
  recordedCalls: RecordedToolCall[],
  successfulCompletions: RecordedCompletion[],
  lastInteractionOrder: number,
  allowCompletionProof: boolean,
  correlation?: ToolFailureDiagnostic['correlation'],
): ToolFailureDiagnostic {
  const { order, callId: _callId, ...result } = diagnostic;
  const latestFailureOrder = diagnostics.at(-1)?.order ?? order;
  const completion = finalCompletion(
    successfulCompletions,
    latestFailureOrder,
    lastInteractionOrder,
    allowCompletionProof,
  );
  return {
    ...result,
    ...(transcriptReplaySafe(recordedCalls, diagnostics, allowCompletionProof)
      ? { replaySafe: true as const }
      : {}),
    ...(completion
      ? {
          completionAfterFailure: true as const,
          completionValue: completion.value,
        }
      : {}),
    ...(correlation ? { correlation } : {}),
  };
}

function finalCompletion(
  completions: RecordedCompletion[],
  latestFailureOrder: number,
  lastInteractionOrder: number,
  allowCompletionProof: boolean,
): RecordedCompletion | undefined {
  if (!allowCompletionProof || completions.length !== 1) return undefined;
  const completion = completions[0];
  return completion &&
    completion.order > latestFailureOrder &&
    completion.order === lastInteractionOrder
    ? completion
    : undefined;
}

function isSessionFilePath(path: string): boolean {
  return (
    isAbsolute(path) &&
    !path.includes('\0') &&
    basename(path) === SESSION_FILE_NAME &&
    SESSION_RUN_DIRECTORY.test(basename(dirname(path)))
  );
}

function pathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function readContainedSessionTail(
  sessionFile: string,
  trustedRoot: string,
  identity: SubagentSessionIdentity,
): Promise<SessionTail | undefined> {
  if (
    !isSessionFilePath(sessionFile) ||
    !isAbsolute(trustedRoot) ||
    trustedRoot.includes('\0') ||
    !pathWithin(trustedRoot, sessionFile) ||
    !isValidSessionIdentity(identity) ||
    resolve(sessionFile) !==
      resolve(
        trustedRoot,
        identity.runId,
        `run-${identity.childIndex}`,
        SESSION_FILE_NAME,
      )
  ) {
    return undefined;
  }

  const resolvedSessionFile = resolve(sessionFile);
  const inspected = await lstat(resolvedSessionFile);
  if (inspected.isSymbolicLink() || !inspected.isFile()) return undefined;

  const [canonicalRoot, canonicalSessionFile] = await Promise.all([
    realpath(trustedRoot),
    realpath(resolvedSessionFile),
  ]);
  if (!pathWithin(canonicalRoot, canonicalSessionFile)) return undefined;

  const handle = await open(
    canonicalSessionFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return undefined;
    const bytesToRead = Math.min(opened.size, MAX_SESSION_TAIL_BYTES);
    if (bytesToRead === 0) return { content: '', truncated: false };
    const start = opened.size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1 ? '' : content.slice(firstNewline + 1);
    }
    return { content, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

function isValidSessionIdentity(identity: SubagentSessionIdentity): boolean {
  return (
    identity.runId.length > 0 &&
    !identity.runId.includes('\0') &&
    basename(identity.runId) === identity.runId &&
    identity.runId !== '.' &&
    identity.runId !== '..' &&
    Number.isSafeInteger(identity.childIndex) &&
    identity.childIndex >= 0
  );
}

export function deriveSubagentSessionRoot(
  parentSessionFile: string | undefined,
): string | undefined {
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
}

export async function readToolFailureDiagnostic(
  sessionFile: string | undefined,
  trustedRoot: string | undefined,
  identity: SubagentSessionIdentity | undefined,
  expectedTool?: string,
  terminalError?: string,
): Promise<ToolFailureDiagnostic | undefined> {
  if (!sessionFile || !trustedRoot || !identity) return undefined;
  try {
    const tail = await readContainedSessionTail(
      sessionFile,
      trustedRoot,
      identity,
    );
    return parseToolFailureDiagnostic(
      tail?.content ?? '',
      expectedTool,
      terminalError,
      tail?.truncated !== true,
    );
  } catch {
    return undefined;
  }
}

export function formatToolFailureDiagnostic(
  diagnostic: ToolFailureDiagnostic,
): string[] {
  return [
    `Failed tool: ${diagnostic.tool}`,
    ...(diagnostic.call
      ? [
          `${diagnostic.tool === 'bash' ? 'Command' : 'Arguments'}: ${diagnostic.call}`,
        ]
      : []),
    ...(diagnostic.output ? [`Tool error: ${diagnostic.output}`] : []),
    ...(diagnostic.correlation === 'latest-before-completion'
      ? [
          'Correlation: latest failed tool call before successful structured_output; terminal text did not identify the call',
        ]
      : []),
  ];
}
