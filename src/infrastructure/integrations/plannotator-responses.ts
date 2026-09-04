import type {
  PlannotatorReviewResult,
  PlannotatorStartResponse,
  PlannotatorStatusResponse,
} from '../../domain/index.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errorText = (
  value: Readonly<Record<string, unknown>>,
  fallback: string,
): string =>
  typeof value.error === 'string' && value.error.trim()
    ? value.error
    : fallback;

/**
 * Normalizes an untrusted response to a Plannotator start request.
 */
export const normalizePlannotatorStartResponse = (
  value: unknown,
): PlannotatorStartResponse => {
  if (!isRecord(value)) {
    return {
      status: 'error',
      error: 'Plannotator returned an invalid response',
    };
  }
  if (value.status === 'unavailable') {
    return {
      status: 'unavailable',
      error: errorText(value, 'Plannotator is unavailable'),
    };
  }
  if (value.status === 'error') {
    return {
      status: 'error',
      error: errorText(value, 'Plannotator failed'),
    };
  }

  const result = isRecord(value.result) ? value.result : undefined;
  if (
    value.status === 'handled' &&
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
};

/**
 * Normalizes an untrusted response to a Plannotator status request.
 */
export const normalizePlannotatorStatusResponse = (
  value: unknown,
  requestedReviewId: string,
): PlannotatorStatusResponse => {
  if (!isRecord(value)) {
    return {
      status: 'error',
      error: 'Plannotator returned an invalid response',
    };
  }
  if (value.status === 'unavailable') {
    return {
      status: 'unavailable',
      error: errorText(value, 'Plannotator is unavailable'),
    };
  }
  if (value.status === 'error') {
    return {
      status: 'error',
      error: errorText(value, 'Plannotator failed'),
    };
  }

  const result = isRecord(value.result) ? value.result : undefined;
  if (value.status !== 'handled' || !result) {
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
};

/**
 * Parses a pushed Plannotator review result.
 */
export const parsePlannotatorResult = (
  value: unknown,
): PlannotatorReviewResult | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.reviewId !== 'string' ||
    typeof value.approved !== 'boolean'
  ) {
    return undefined;
  }
  return {
    reviewId: value.reviewId,
    approved: value.approved,
    feedback: typeof value.feedback === 'string' ? value.feedback : '',
  };
};
