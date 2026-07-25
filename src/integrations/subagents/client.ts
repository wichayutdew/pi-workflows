import {
  createDelegation,
  DEFAULT_CLIENT_DEPENDENCIES,
} from './client-delegation.ts';
import type {
  ActiveDelegation,
  DelegateOptions,
  SubagentDelegationClientDependencies,
  SubagentEventBus,
} from './client-types.ts';
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
} from './protocol-events.ts';

export type {
  DelegateOptions,
  SubagentDelegationClientDependencies,
  SubagentEventBus,
} from './client-types.ts';

/**
 * Functional surface used by workflow orchestration.
 */
export type SubagentDelegationClientController = {
  /** Request currently owned by this client, if any. */
  readonly activeRequestId: string | undefined;
  /** Starts one correlated delegation. */
  readonly delegate: (
    request: SubagentDelegationRequest,
    options?: DelegateOptions,
  ) => Promise<SubagentDelegationResponse>;
  /** Cancels the active delegation and waits for terminal confirmation. */
  readonly cancelActiveAndWait: (waitMs?: number) => Promise<boolean>;
};

/**
 * Creates an isolated subagent delegation controller.
 *
 * @param events - Event transport shared with the subagent runtime.
 * @param dependencies - Timer effects used for cancellation and timeouts.
 * @returns A controller that owns at most one active delegation.
 */
export function createSubagentDelegationClient(
  events: SubagentEventBus,
  dependencies: SubagentDelegationClientDependencies = DEFAULT_CLIENT_DEPENDENCIES,
): SubagentDelegationClientController {
  let active: ActiveDelegation | undefined;

  const delegate = (
    request: SubagentDelegationRequest,
    options: DelegateOptions = {},
  ): Promise<SubagentDelegationResponse> => {
    if (active) {
      return Promise.reject(
        new Error(`subagent request "${active.requestId}" is still active`),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('subagent delegation was cancelled'));
    }

    const delegation = createDelegation({
      events,
      request,
      options,
      dependencies,
      releaseActive: (requestId) => {
        if (active?.requestId === requestId) active = undefined;
      },
    });
    active = delegation.active;
    delegation.start();
    return delegation.promise;
  };

  const cancelActiveAndWait = (waitMs = 5_000): Promise<boolean> => {
    const current = active;
    if (!current) return Promise.resolve(true);

    current.requestCancellation();
    return new Promise<boolean>((resolve) => {
      let isFinished = false;
      const finish = (isConfirmed: boolean): void => {
        if (isFinished) return;
        isFinished = true;
        dependencies.cancelTimeout(timer);
        resolve(isConfirmed);
      };
      const timer = dependencies.scheduleTimeout(() => {
        finish(false);
      }, waitMs);
      void current.terminal.then(() => {
        finish(true);
      });
    });
  };

  return {
    get activeRequestId() {
      return active?.requestId;
    },
    delegate,
    cancelActiveAndWait,
  };
}

/**
 * Coordinates one foreground pi-subagents request at a time.
 *
 * Event and timer boundaries are constructor-injected; production defaults
 * preserve the original runtime behavior.
 */
export class SubagentDelegationClient implements SubagentDelegationClientController {
  readonly #controller: SubagentDelegationClientController;

  /**
   * Creates a client over the supplied event and timer boundaries.
   */
  constructor(
    events: SubagentEventBus,
    dependencies: SubagentDelegationClientDependencies = DEFAULT_CLIENT_DEPENDENCIES,
  ) {
    this.#controller = createSubagentDelegationClient(events, dependencies);
  }

  /** Returns the request currently owned by this client, if any. */
  get activeRequestId(): string | undefined {
    return this.#controller.activeRequestId;
  }

  /**
   * Starts a correlated delegation and resolves on its terminal event.
   */
  delegate(
    request: SubagentDelegationRequest,
    options: DelegateOptions = {},
  ): Promise<SubagentDelegationResponse> {
    return this.#controller.delegate(request, options);
  }

  /**
   * Requests cancellation and waits briefly for terminal confirmation.
   */
  cancelActiveAndWait(waitMs = 5_000): Promise<boolean> {
    return this.#controller.cancelActiveAndWait(waitMs);
  }
}
