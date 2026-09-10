export type EventBusLike = {
  readonly emit: (channel: string, data: unknown) => void;
  readonly on: (
    channel: string,
    handler: (data: unknown) => void,
  ) => () => void;
};

export type PlannotatorReviewStarted = {
  readonly status: 'pending';
  readonly reviewId: string;
};

export type PlannotatorStartResponse =
  | {
      readonly status: 'handled';
      readonly result: PlannotatorReviewStarted;
    }
  | { readonly status: 'unavailable'; readonly error?: string }
  | { readonly status: 'error'; readonly error: string };

export type PlannotatorReviewStatus =
  | { readonly status: 'pending' }
  | {
      readonly status: 'completed';
      readonly reviewId: string;
      readonly approved: boolean;
      readonly feedback: string;
    }
  | { readonly status: 'missing' };

export type PlannotatorStatusResponse =
  | {
      readonly status: 'handled';
      readonly result: PlannotatorReviewStatus;
    }
  | { readonly status: 'unavailable'; readonly error?: string }
  | { readonly status: 'error'; readonly error: string };

export type PlannotatorReviewResult = {
  readonly reviewId: string;
  readonly approved: boolean;
  readonly feedback: string;
};
