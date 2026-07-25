import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_PROTOCOL_VERSION,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationStatus,
  type SubagentDelegationUpdate,
} from './protocol.ts';

export interface SubagentEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export interface DelegateOptions {
  signal?: AbortSignal;
  startTimeoutMs?: number;
  onUpdate?: (update: SubagentDelegationUpdate) => void;
  /**
   * Called when a terminal response arrives after the delegate promise already
   * rejected locally. The child was still potentially alive until this event.
   */
  onLateTerminal?: (response: SubagentDelegationResponse) => void;
}

interface ActiveDelegation {
  requestId: string;
  requestCancellation: () => void;
  terminal: Promise<void>;
}

const DELEGATION_STATUSES = new Set<SubagentDelegationStatus>([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
  'turn_budget_exhausted',
  'tool_budget_exhausted',
  'acceptance_failed',
  'invalid_request',
  'unavailable_context',
]);

function requestIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}

function parseResponse(value: unknown): SubagentDelegationResponse | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const response = value as Partial<SubagentDelegationResponse>;
  if (
    response.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION ||
    typeof response.requestId !== 'string' ||
    typeof response.status !== 'string' ||
    !DELEGATION_STATUSES.has(response.status as SubagentDelegationStatus)
  ) {
    return undefined;
  }
  return response as SubagentDelegationResponse;
}

function parseUpdate(value: unknown): SubagentDelegationUpdate | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const update = value as Partial<SubagentDelegationUpdate>;
  if (
    update.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION ||
    typeof update.requestId !== 'string'
  ) {
    return undefined;
  }
  return update as SubagentDelegationUpdate;
}

export class SubagentDelegationClient {
  private readonly events: SubagentEventBus;
  private active: ActiveDelegation | undefined;

  constructor(events: SubagentEventBus) {
    this.events = events;
  }

  get activeRequestId(): string | undefined {
    return this.active?.requestId;
  }

  delegate(
    request: SubagentDelegationRequest,
    options: DelegateOptions = {},
  ): Promise<SubagentDelegationResponse> {
    if (this.active) {
      return Promise.reject(
        new Error(
          `subagent request "${this.active.requestId}" is still active`,
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('subagent delegation was cancelled'));
    }

    let start: () => void = () => undefined;
    let requestCancellation: () => void = () => undefined;
    let resolveTerminal: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const delegation = new Promise<SubagentDelegationResponse>(
      (resolve, reject) => {
        let settled = false;
        let cancellationRequested = false;
        const subscriptions: Array<() => void> = [];
        const startTimeoutMs = options.startTimeoutMs ?? 3_000;
        const overallTimeoutMs = (request.timeoutMs ?? 900_000) + 5_000;

        const subscribe = (
          event: string,
          handler: (data: unknown) => void,
        ): void => {
          const unsubscribe = this.events.on(event, handler);
          if (typeof unsubscribe === 'function')
            subscriptions.push(unsubscribe);
        };
        const stopLocalWatchers = (): void => {
          clearTimeout(startTimer);
          clearTimeout(overallTimer);
          options.signal?.removeEventListener('abort', abort);
        };
        const cleanup = (): void => {
          stopLocalWatchers();
          for (const unsubscribe of subscriptions) unsubscribe();
          if (this.active?.requestId === request.requestId)
            this.active = undefined;
        };
        const finish = (
          result: { response: SubagentDelegationResponse } | { error: Error },
        ): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if ('response' in result) resolve(result.response);
          else reject(result.error);
        };
        const emitCancel = (): void => {
          if (cancellationRequested || settled) return;
          cancellationRequested = true;
          this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
            version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
            requestId: request.requestId,
          });
        };
        const failAndCancel = (reason: string): void => {
          if (settled) return;
          emitCancel();
          // A local timeout is not proof that the child process terminated. Reject
          // the caller, but retain correlation listeners and active ownership
          // until pi-subagents emits the terminal response.
          if (settled) return;
          settled = true;
          stopLocalWatchers();
          reject(new Error(reason));
        };
        const abort = (): void => {
          failAndCancel('subagent delegation was cancelled');
        };
        requestCancellation = emitCancel;

        subscribe(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => {
          if (requestIdOf(data) !== request.requestId) return;
          clearTimeout(startTimer);
        });
        subscribe(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
          const update = parseUpdate(data);
          if (!update || update.requestId !== request.requestId) return;
          options.onUpdate?.(update);
        });
        subscribe(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
          const response = parseResponse(data);
          if (!response || response.requestId !== request.requestId) return;
          resolveTerminal();
          if (settled) {
            cleanup();
            options.onLateTerminal?.(response);
            return;
          }
          finish({ response });
        });

        const startTimer = setTimeout(() => {
          failAndCancel(
            'pi-subagents did not accept the delegation request; verify it is installed and loaded',
          );
        }, startTimeoutMs);
        const overallTimer = setTimeout(() => {
          failAndCancel(
            'pi-subagents did not settle the delegation request before its deadline',
          );
        }, overallTimeoutMs);
        startTimer.unref?.();
        overallTimer.unref?.();

        options.signal?.addEventListener('abort', abort, { once: true });
        start = () =>
          this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
      },
    );

    this.active = {
      requestId: request.requestId,
      requestCancellation,
      terminal,
    };
    start();
    return delegation;
  }

  async cancelActiveAndWait(waitMs = 5_000): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    active.requestCancellation();
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (confirmed: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      void active.terminal.then(() => finish(true));
    });
  }
}
