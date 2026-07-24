export const PLANNOTATOR_REQUEST_CHANNEL = 'plannotator:request';
export const PLANNOTATOR_RESULT_CHANNEL = 'plannotator:review-result';

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PlannotatorReviewStarted {
  status: 'pending';
  reviewId: string;
}

export type PlannotatorStartResponse =
  | { status: 'handled'; result: PlannotatorReviewStarted }
  | { status: 'unavailable'; error?: string }
  | { status: 'error'; error: string };

export type PlannotatorReviewStatus =
  | { status: 'pending' }
  | {
      status: 'completed';
      reviewId: string;
      approved: boolean;
      feedback: string;
    }
  | { status: 'missing' };

export type PlannotatorStatusResponse =
  | { status: 'handled'; result: PlannotatorReviewStatus }
  | { status: 'unavailable'; error?: string }
  | { status: 'error'; error: string };

export interface PlannotatorReviewResult {
  reviewId: string;
  approved: boolean;
  feedback: string;
}

function errorText(value: Record<string, unknown>, fallback: string): string {
  return typeof value.error === 'string' && value.error.trim()
    ? value.error
    : fallback;
}

function normalizeStartResponse(value: unknown): PlannotatorStartResponse {
  if (value === null || typeof value !== 'object') {
    return {
      status: 'error',
      error: 'Plannotator returned an invalid response',
    };
  }
  const response = value as Record<string, unknown>;
  if (response.status === 'unavailable') {
    return {
      status: 'unavailable',
      error: errorText(response, 'Plannotator is unavailable'),
    };
  }
  if (response.status === 'error') {
    return {
      status: 'error',
      error: errorText(response, 'Plannotator failed'),
    };
  }
  const result =
    response.result !== null && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : undefined;
  if (
    response.status === 'handled' &&
    result?.status === 'pending' &&
    typeof result.reviewId === 'string'
  ) {
    return {
      status: 'handled',
      result: { status: 'pending', reviewId: result.reviewId },
    };
  }
  return {
    status: 'error',
    error: 'Plannotator returned an invalid start result',
  };
}

function normalizeStatusResponse(
  value: unknown,
  requestedReviewId: string,
): PlannotatorStatusResponse {
  if (value === null || typeof value !== 'object') {
    return {
      status: 'error',
      error: 'Plannotator returned an invalid response',
    };
  }
  const response = value as Record<string, unknown>;
  if (response.status === 'unavailable') {
    return {
      status: 'unavailable',
      error: errorText(response, 'Plannotator is unavailable'),
    };
  }
  if (response.status === 'error') {
    return {
      status: 'error',
      error: errorText(response, 'Plannotator failed'),
    };
  }
  const result =
    response.result !== null && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : undefined;
  if (response.status !== 'handled' || !result) {
    return {
      status: 'error',
      error: 'Plannotator returned an invalid status result',
    };
  }
  if (result.status === 'pending' || result.status === 'missing') {
    return { status: 'handled', result: { status: result.status } };
  }
  if (
    result.status === 'completed' &&
    typeof result.reviewId === 'string' &&
    typeof result.approved === 'boolean'
  ) {
    if (result.reviewId !== requestedReviewId) {
      return {
        status: 'error',
        error: 'Plannotator returned a result for a different review',
      };
    }
    return {
      status: 'handled',
      result: {
        status: 'completed',
        reviewId: result.reviewId,
        approved: result.approved,
        feedback: typeof result.feedback === 'string' ? result.feedback : '',
      },
    };
  }
  return {
    status: 'error',
    error: 'Plannotator returned an invalid status result',
  };
}

export function parsePlannotatorResult(
  value: unknown,
): PlannotatorReviewResult | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  if (
    typeof result.reviewId !== 'string' ||
    typeof result.approved !== 'boolean'
  ) {
    return undefined;
  }
  return {
    reviewId: result.reviewId,
    approved: result.approved,
    feedback: typeof result.feedback === 'string' ? result.feedback : '',
  };
}

export function requestPlannotatorReview(
  events: EventBusLike,
  requestId: string,
  content: string,
  origin: string,
  timeoutMs: number,
): Promise<PlannotatorStartResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeStartResponse(response));
    };
    const timer = setTimeout(
      () =>
        finish({
          status: 'unavailable',
          error: `Plannotator did not respond within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    timer.unref?.();

    events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId,
      action: 'plan-review',
      payload: {
        planContent: content,
        origin,
      },
      respond: finish,
    });
  });
}

export function requestPlannotatorReviewStatus(
  events: EventBusLike,
  requestId: string,
  reviewId: string,
  timeoutMs: number,
): Promise<PlannotatorStatusResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeStatusResponse(response, reviewId));
    };
    const timer = setTimeout(
      () =>
        finish({
          status: 'unavailable',
          error: `Plannotator did not respond within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    timer.unref?.();

    events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId,
      action: 'review-status',
      payload: { reviewId },
      respond: finish,
    });
  });
}
