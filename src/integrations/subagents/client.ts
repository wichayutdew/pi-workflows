import { spawn, type ChildProcess } from 'node:child_process';
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
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
        if (active?.process === child) active = undefined;
        options.signal?.removeEventListener('abort', abort);
        resolve({
          requestId: request.requestId,
          agent: request.agent,
          status: code === 0 ? 'completed' : signal ? 'cancelled' : 'failed',
          ...(code === null ? {} : { exitCode: code }),
          ...(stderr.trim() ? { error: stderr.trim().slice(-4_000) } : {}),
        });
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
