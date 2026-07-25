import type {
  SubagentDelegationResponse,
  SubagentDelegationUpdate,
} from './protocol-events.ts';

export type SubagentEventBus = {
  readonly on: (event: string, handler: (data: unknown) => void) => unknown;
  readonly emit: (event: string, data: unknown) => void;
};

export type DelegateOptions = {
  readonly signal?: AbortSignal;
  readonly startTimeoutMs?: number;
  readonly onUpdate?: (update: SubagentDelegationUpdate) => void;
  /**
   * Called when a terminal response arrives after the delegate promise already
   * rejected locally. The child was still potentially alive until this event.
   */
  readonly onLateTerminal?: (response: SubagentDelegationResponse) => void;
};

export type DelegationTimer = ReturnType<typeof setTimeout>;

export type SubagentDelegationClientDependencies = {
  readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => DelegationTimer;
  readonly cancelTimeout: (timer: DelegationTimer) => void;
};

export type ActiveDelegation = {
  readonly requestId: string;
  readonly requestCancellation: () => void;
  readonly terminal: Promise<void>;
};
