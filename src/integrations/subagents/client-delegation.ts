import {
  parseDelegationResponse,
  parseDelegationUpdate,
  requestIdOf,
} from './client-messages.ts';
import type {
  ActiveDelegation,
  DelegateOptions,
  DelegationTimer,
  SubagentDelegationClientDependencies,
  SubagentEventBus,
} from './client-types.ts';
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_PROTOCOL_VERSION,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
} from './protocol-events.ts';
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
} from './protocol-events.ts';

export const DEFAULT_CLIENT_DEPENDENCIES = {
  scheduleTimeout: (callback: () => void, timeoutMs: number) =>
    setTimeout(callback, timeoutMs),
  cancelTimeout: (timer: DelegationTimer) => {
    clearTimeout(timer);
  },
} as const satisfies SubagentDelegationClientDependencies;

type CreatedDelegation = {
  readonly active: ActiveDelegation;
  readonly promise: Promise<SubagentDelegationResponse>;
  readonly start: () => void;
};

type CreateDelegationOptions = {
  readonly events: SubagentEventBus;
  readonly request: SubagentDelegationRequest;
  readonly options: DelegateOptions;
  readonly dependencies: SubagentDelegationClientDependencies;
  readonly releaseActive: (requestId: string) => void;
};

function isUnsubscribe(value: unknown): value is () => void {
  return typeof value === 'function';
}

/**
 * Creates one delegation lifecycle without retaining client-level state.
 */
export const createDelegation = ({
  events,
  request,
  options,
  dependencies,
  releaseActive,
}: CreateDelegationOptions): CreatedDelegation => {
  let requestCancellation = (): void => undefined;
  let resolveTerminal = (): void => undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const promise = new Promise<SubagentDelegationResponse>((resolve, reject) => {
    let isSettled = false;
    let isCancellationRequested = false;
    const subscriptions: Array<() => void> = [];

    const subscribe = (
      event: string,
      handler: (data: unknown) => void,
    ): void => {
      const unsubscribe = events.on(event, handler);
      if (isUnsubscribe(unsubscribe)) {
        subscriptions.push(() => {
          unsubscribe();
        });
      }
    };
    const stopLocalWatchers = (): void => {
      dependencies.cancelTimeout(startTimer);
      dependencies.cancelTimeout(overallTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const cleanup = (): void => {
      stopLocalWatchers();
      for (const unsubscribe of subscriptions) unsubscribe();
      releaseActive(request.requestId);
    };
    const finish = (
      result:
        | { readonly response: SubagentDelegationResponse }
        | { readonly error: Error },
    ): void => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      if ('response' in result) resolve(result.response);
      else reject(result.error);
    };
    const emitCancel = (): void => {
      if (isCancellationRequested || isSettled) return;
      isCancellationRequested = true;
      events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
        version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
        requestId: request.requestId,
      });
    };
    const failAndCancel = (reason: string): void => {
      if (isSettled) return;
      emitCancel();
      // A local timeout is not proof that the child process terminated.
      // Retain correlation listeners and ownership until the terminal event.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- emitting cancellation can synchronously settle through the event bus
      if (isSettled) return;
      isSettled = true;
      stopLocalWatchers();
      reject(new Error(reason));
    };
    const abort = (): void => {
      failAndCancel('subagent delegation was cancelled');
    };
    requestCancellation = emitCancel;

    subscribe(SUBAGENT_DELEGATION_STARTED_EVENT, (data) => {
      if (requestIdOf(data) !== request.requestId) return;
      dependencies.cancelTimeout(startTimer);
    });
    subscribe(SUBAGENT_DELEGATION_UPDATE_EVENT, (data) => {
      const update = parseDelegationUpdate(data);
      if (!update || update.requestId !== request.requestId) return;
      options.onUpdate?.(update);
    });
    subscribe(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
      const response = parseDelegationResponse(data);
      if (!response || response.requestId !== request.requestId) return;
      resolveTerminal();
      if (isSettled) {
        cleanup();
        options.onLateTerminal?.(response);
        return;
      }
      finish({ response });
    });

    const startTimer = dependencies.scheduleTimeout(() => {
      failAndCancel(
        'pi-subagents did not accept the delegation request; verify it is installed and loaded',
      );
    }, options.startTimeoutMs ?? 3_000);
    const overallTimer = dependencies.scheduleTimeout(
      () => {
        failAndCancel(
          'pi-subagents did not settle the delegation request before its deadline',
        );
      },
      (request.timeoutMs ?? 900_000) + 5_000,
    );
    startTimer.unref();
    overallTimer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
  });

  return {
    active: {
      requestId: request.requestId,
      requestCancellation: () => {
        requestCancellation();
      },
      terminal,
    },
    promise,
    start: () => {
      events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
    },
  };
};
