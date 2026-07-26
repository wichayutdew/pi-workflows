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
  readonly ignoreResponse?: (response: unknown) => boolean;
  readonly dependencies: PlannotatorDependencies;
};

const requestResponse = <TResponse>({
  events,
  request,
  timeoutMs,
  timeoutResponse,
  normalize,
  ignoreResponse,
  dependencies,
}: RequestResponseOptions<TResponse>): Promise<TResponse> =>
  new Promise((resolve) => {
    let isSettled = false;
    const finish = (response: unknown): void => {
      if (isSettled || ignoreResponse?.(response)) return;
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

const MISSING_PLAN_CONTENT_RESPONSE =
  'Missing planContent for plan-review request.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isUnclaimedPlanReviewResponse = (response: unknown): boolean =>
  isRecord(response) &&
  response.status === 'error' &&
  response.error === MISSING_PLAN_CONTENT_RESPONSE;

/**
 * Pi keeps its shared event bus across extension reloads. Plannotator versions
 * that do not dispose their request listener can therefore receive one request
 * multiple times and open one browser pane per stale listener. A consumable
 * plan value lets exactly one listener claim the side-effecting request.
 */
const singleConsumerPlanPayload = (
  planContent: string,
  origin: string,
): Readonly<Record<string, unknown>> => {
  let claimed = false;

  return {
    get planContent(): string | undefined {
      if (claimed) return undefined;
      claimed = true;
      return planContent;
    },
    origin,
  };
};

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
      payload: singleConsumerPlanPayload(content, origin),
    },
    timeoutMs,
    timeoutResponse: {
      status: 'unavailable',
      error: `Plannotator did not respond within ${timeoutMs}ms`,
    },
    normalize: normalizePlannotatorStartResponse,
    ...(content.trim()
      ? { ignoreResponse: isUnclaimedPlanReviewResponse }
      : {}),
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
