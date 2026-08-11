import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationUpdate,
} from './protocol-events.ts';

export type DelegateOptions = {
  readonly signal?: AbortSignal;
  readonly onUpdate?: (update: { readonly requestId: string }) => void;
  readonly onLateTerminal?: (response: SubagentDelegationResponse) => void;
};

/** A pi-workflows-owned foreground Pi process. */
export type SubagentDelegationClientController = {
  readonly activeRequestId: string | undefined;
  readonly delegate: (
    request: SubagentDelegationRequest,
    options?: DelegateOptions,
  ) => Promise<SubagentDelegationResponse>;
  readonly cancelActiveAndWait: (waitMs?: number) => Promise<boolean>;
};

export const directWorkerCommand = (
  request: SubagentDelegationRequest,
): ReadonlyArray<string> => [
  '--no-session',
  '--mode',
  'json',
  ...(request.model ? ['--model', request.model] : []),
  ...(request.thinking ? ['--thinking', request.thinking] : []),
  '--print',
  request.task,
];

export function directWorkerResponse(
  request: SubagentDelegationRequest,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): SubagentDelegationResponse {
  const status = code === 0 ? 'completed' : signal ? 'cancelled' : 'failed';
  return {
    requestId: request.requestId,
    agent: request.agent,
    status,
    ...(code === null ? {} : { exitCode: code }),
    ...(status !== 'completed' && stderr.trim()
      ? { error: stderr.trim().slice(-4_000) }
      : {}),
  };
}

type WorkerJsonEvent = {
  readonly type?: unknown;
  readonly toolName?: unknown;
  readonly args?: unknown;
  readonly message?: { readonly role?: unknown };
  readonly assistantMessageEvent?: {
    readonly type?: unknown;
    readonly delta?: unknown;
  };
};

type WorkerProgress = {
  readonly toolCount: number;
  readonly responseText: string;
  readonly update?: SubagentDelegationUpdate;
};

const MAX_PROGRESS_DETAIL_CHARS = 480;
const SECRET_KEY = /authorization|cookie|password|secret|token|api[-_]?key/i;

function redactProgressValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value.length > MAX_PROGRESS_DETAIL_CHARS
      ? `${value.slice(0, MAX_PROGRESS_DETAIL_CHARS - 1)}…`
      : value;
  }
  if (Array.isArray(value))
    return value.map((item) => redactProgressValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactProgressValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function formatToolCall(toolName: string, args: unknown): string {
  const rendered = JSON.stringify(redactProgressValue(args));
  const detail = rendered === undefined ? '' : ` ${rendered}`;
  return `call ${toolName}${detail}`.slice(0, MAX_PROGRESS_DETAIL_CHARS);
}

/** Converts one Pi JSONL event into safe, operator-visible worker progress. */
export function workerProgressFromJsonLine(
  line: string,
  requestId: string,
  toolCount: number,
  responseText = '',
): WorkerProgress {
  let event: WorkerJsonEvent;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object')
      return { toolCount, responseText };
    event = parsed as WorkerJsonEvent;
  } catch {
    return { toolCount, responseText };
  }
  if (event.type === 'agent_start') {
    return {
      toolCount,
      responseText,
      update: { requestId, activity: 'thinking', toolCount },
    };
  }
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    return { toolCount, responseText: '' };
  }
  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent?.type === 'text_delta' &&
    typeof event.assistantMessageEvent.delta === 'string'
  ) {
    const nextResponseText =
      `${responseText}${event.assistantMessageEvent.delta}`.slice(
        -MAX_PROGRESS_DETAIL_CHARS,
      );
    return {
      toolCount,
      responseText: nextResponseText,
      update: {
        requestId,
        activity: 'responding',
        detail: `response: ${nextResponseText}`,
        toolCount,
      },
    };
  }
  if (
    (event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update') &&
    typeof event.toolName === 'string'
  ) {
    const nextToolCount =
      event.type === 'tool_execution_start' ? toolCount + 1 : toolCount;
    return {
      toolCount: nextToolCount,
      responseText,
      update: {
        requestId,
        currentTool: event.toolName,
        ...(event.type === 'tool_execution_start'
          ? { detail: formatToolCall(event.toolName, event.args) }
          : {}),
        toolCount: nextToolCount,
      },
    };
  }
  return { toolCount, responseText };
}

export function createSubagentDelegationClient(): SubagentDelegationClientController {
  let active: { requestId: string; process: ChildProcess } | undefined;

  const delegate = (
    request: SubagentDelegationRequest,
    options: DelegateOptions = {},
  ): Promise<SubagentDelegationResponse> => {
    if (active) {
      return Promise.reject(
        new Error(`workflow worker "${active.requestId}" is still active`),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('workflow worker was cancelled'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn('pi', directWorkerCommand(request), {
        cwd: request.cwd,
        env: {
          ...process.env,
          PI_WORKFLOWS_CHILD: '1',
          PI_WORKFLOWS_CHILD_AGENT: request.agent,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      active = { requestId: request.requestId, process: child };
      let stderr = '';
      let stdoutBuffer = '';
      let toolCount = 0;
      let responseText = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const consumeWorkerLines = (): void => {
        while (true) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline === -1) return;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          const progress = workerProgressFromJsonLine(
            line,
            request.requestId,
            toolCount,
            responseText,
          );
          toolCount = progress.toolCount;
          responseText = progress.responseText;
          if (progress.update) options.onUpdate?.(progress.update);
        }
      };
      const consumeWorkerOutput = (chunk: Buffer): void => {
        stdoutBuffer += stdoutDecoder.write(chunk);
        consumeWorkerLines();
      };
      child.stdout?.on('data', consumeWorkerOutput);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const abort = (): void => {
        child.kill('SIGTERM');
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => {
        if (active?.process === child) active = undefined;
        reject(error);
      });
      child.once('close', (code, signal) => {
        stdoutBuffer += stdoutDecoder.end();
        consumeWorkerLines();
        if (active?.process === child) active = undefined;
        options.signal?.removeEventListener('abort', abort);
        resolve(directWorkerResponse(request, code, signal, stderr));
      });
    });
  };

  return {
    get activeRequestId() {
      return active?.requestId;
    },
    delegate,
    async cancelActiveAndWait(): Promise<boolean> {
      const current = active;
      if (!current) return true;
      current.process.kill('SIGTERM');
      return new Promise((resolve) =>
        current.process.once('close', () => resolve(true)),
      );
    },
  };
}

export class SubagentDelegationClient implements SubagentDelegationClientController {
  readonly #client = createSubagentDelegationClient();
  get activeRequestId(): string | undefined {
    return this.#client.activeRequestId;
  }
  delegate(
    request: SubagentDelegationRequest,
    options?: DelegateOptions,
  ): Promise<SubagentDelegationResponse> {
    return this.#client.delegate(request, options);
  }
  cancelActiveAndWait(waitMs?: number): Promise<boolean> {
    return this.#client.cancelActiveAndWait(waitMs);
  }
}
