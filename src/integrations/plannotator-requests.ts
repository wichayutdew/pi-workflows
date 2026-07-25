import {
  normalizePlannotatorStartResponse,
  normalizePlannotatorStatusResponse,
} from './plannotator-responses.ts';
import type {
  EventBusLike,
  PlannotatorStartResponse,
  PlannotatorStatusResponse,
} from './plannotator-types.ts';

export const PLANNOTATOR_REQUEST_CHANNEL = 'plannotator:request';
export const PLANNOTATOR_RESULT_CHANNEL = 'plannotator:review-result';

type TimeoutHandle = ReturnType<typeof setTimeout>;

export type PlannotatorDependencies = {
  readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => TimeoutHandle;
  readonly cancelTimeout: (handle: TimeoutHandle) => void;
};

const DEFAULT_DEPENDENCIES = {
  scheduleTimeout: (callback: () => void, timeoutMs: number) =>
    setTimeout(callback, timeoutMs),
  cancelTimeout: (handle: TimeoutHandle) => {
    clearTimeout(handle);
  },
} as const satisfies PlannotatorDependencies;

type RequestResponseOptions<TResponse> = {
  readonly events: EventBusLike;
  readonly request: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly timeoutResponse: TResponse;
  readonly normalize: (response: unknown) => TResponse;
  readonly dependencies: PlannotatorDependencies;
};

const requestResponse = <TResponse>({
  events,
  request,
  timeoutMs,
  timeoutResponse,
  normalize,
  dependencies,
}: RequestResponseOptions<TResponse>): Promise<TResponse> =>
  new Promise((resolve) => {
    let isSettled = false;
    const finish = (response: unknown): void => {
      if (isSettled) return;
      isSettled = true;
      dependencies.cancelTimeout(timer);
      resolve(normalize(response));
    };
    const timer = dependencies.scheduleTimeout(() => {
      finish(timeoutResponse);
    }, timeoutMs);
    timer.unref();

    events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
      ...request,
      respond: finish,
    });
  });

/**
 * Requests a new Plannotator plan review through the injected event bus.
 *
 * @param dependencies Timer boundaries, injectable for deterministic callers.
 */
export const requestPlannotatorReview = (
  events: EventBusLike,
  requestId: string,
  content: string,
  origin: string,
  timeoutMs: number,
  dependencies: PlannotatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<PlannotatorStartResponse> =>
  requestResponse({
    events,
    request: {
      requestId,
      action: 'plan-review',
      payload: {
        planContent: content,
        origin,
      },
    },
    timeoutMs,
    timeoutResponse: {
      status: 'unavailable',
      error: `Plannotator did not respond within ${timeoutMs}ms`,
    },
    normalize: normalizePlannotatorStartResponse,
    dependencies,
  });

/**
 * Requests the current durable status for a Plannotator review.
 *
 * @param dependencies Timer boundaries, injectable for deterministic callers.
 */
export const requestPlannotatorReviewStatus = (
  events: EventBusLike,
  requestId: string,
  reviewId: string,
  timeoutMs: number,
  dependencies: PlannotatorDependencies = DEFAULT_DEPENDENCIES,
): Promise<PlannotatorStatusResponse> =>
  requestResponse({
    events,
    request: {
      requestId,
      action: 'review-status',
      payload: { reviewId },
    },
    timeoutMs,
    timeoutResponse: {
      status: 'unavailable',
      error: `Plannotator did not respond within ${timeoutMs}ms`,
    },
    normalize: (response) =>
      normalizePlannotatorStatusResponse(response, reviewId),
    dependencies,
  });
