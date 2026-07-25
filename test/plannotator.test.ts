import { describe, expect, test } from 'bun:test';
import {
  parsePlannotatorResult,
  requestPlannotatorReview,
  requestPlannotatorReviewStatus,
} from '../src/integrations/plannotator.ts';

describe('when testing plannotator', () => {
  function respondingEvents(value: unknown) {
    return {
      on: () => () => undefined,
      emit: (_channel: string, data: unknown) => {
        (data as { respond: (response: unknown) => void }).respond(value);
      },
    };
  }

  describe('should satisfy its behavioral contract', () => {
    test('starts a correlated Plannotator plan review', async () => {
      // given
      // when
      // then
      const response = await requestPlannotatorReview(
        {
          on: () => () => undefined,
          emit: (_channel, data) => {
            const request = data as {
              requestId: string;
              action: string;
              respond: (value: unknown) => void;
            };
            expect(request.requestId).toBe('request-1');
            expect(request.action).toBe('plan-review');
            request.respond({
              status: 'handled',
              result: { status: 'pending', reviewId: 'review-1' },
            });
          },
        },
        'request-1',
        '# Plan',
        'test',
        1_000,
      );
      expect(response).toEqual({
        status: 'handled',
        result: { status: 'pending', reviewId: 'review-1' },
      });
    });

    test('queries a durable Plannotator review result', async () => {
      // given
      // when
      // then
      const response = await requestPlannotatorReviewStatus(
        {
          on: () => () => undefined,
          emit: (_channel, data) => {
            const request = data as {
              action: string;
              payload: { reviewId: string };
              respond: (value: unknown) => void;
            };
            expect(request.action).toBe('review-status');
            expect(request.payload.reviewId).toBe('review-1');
            request.respond({
              status: 'handled',
              result: {
                status: 'completed',
                reviewId: 'review-1',
                approved: true,
                feedback: 'Looks good',
              },
            });
          },
        },
        'request-2',
        'review-1',
        1_000,
      );
      expect(response.status).toBe('handled');
      expect(
        response.status === 'handled' ? response.result : undefined,
      ).toEqual({
        status: 'completed',
        reviewId: 'review-1',
        approved: true,
        feedback: 'Looks good',
      });
    });

    test('rejects a status result correlated to another review', async () => {
      // given
      // when
      const response = await requestPlannotatorReviewStatus(
        {
          on: () => () => undefined,
          emit: (_channel, data) => {
            const request = data as { respond: (value: unknown) => void };
            request.respond({
              status: 'handled',
              result: {
                status: 'completed',
                reviewId: 'review-2',
                approved: true,
                feedback: '',
              },
            });
          },
        },
        'request-3',
        'review-1',
        1_000,
      );
      // then
      expect(response).toEqual({
        status: 'error',
        error: 'Plannotator returned a result for a different review',
      });
    });

    test('normalizes every supported and malformed start response', async () => {
      // given
      type StartResponse = Awaited<ReturnType<typeof requestPlannotatorReview>>;
      const scenarios: Array<[unknown, StartResponse]> = [
        [
          null,
          {
            status: 'error',
            error: 'Plannotator returned an invalid response',
          },
        ],
        [
          { status: 'unavailable' },
          { status: 'unavailable', error: 'Plannotator is unavailable' },
        ],
        [
          { status: 'unavailable', error: 'offline' },
          { status: 'unavailable', error: 'offline' },
        ],
        [
          { status: 'error', error: ' ' },
          { status: 'error', error: 'Plannotator failed' },
        ],
        [
          { status: 'error', error: 'broken' },
          { status: 'error', error: 'broken' },
        ],
        [
          { status: 'handled', result: null },
          {
            status: 'error',
            error: 'Plannotator returned an invalid start result',
          },
        ],
      ];

      // when
      const results = await Promise.all(
        scenarios.map(([response]) =>
          requestPlannotatorReview(
            respondingEvents(response),
            'request',
            '# Plan',
            'test',
            100,
          ),
        ),
      );

      // then
      expect(results).toEqual(scenarios.map(([, expected]) => expected));
    });

    test('normalizes every supported and malformed status response', async () => {
      // given
      type StatusResponse = Awaited<
        ReturnType<typeof requestPlannotatorReviewStatus>
      >;
      const scenarios: Array<[unknown, StatusResponse]> = [
        [
          undefined,
          {
            status: 'error',
            error: 'Plannotator returned an invalid response',
          },
        ],
        [
          { status: 'unavailable' },
          { status: 'unavailable', error: 'Plannotator is unavailable' },
        ],
        [{ status: 'error' }, { status: 'error', error: 'Plannotator failed' }],
        [
          { status: 'handled', result: null },
          {
            status: 'error',
            error: 'Plannotator returned an invalid status result',
          },
        ],
        [
          { status: 'handled', result: { status: 'pending' } },
          { status: 'handled', result: { status: 'pending' } },
        ],
        [
          { status: 'handled', result: { status: 'missing' } },
          { status: 'handled', result: { status: 'missing' } },
        ],
        [
          {
            status: 'handled',
            result: {
              status: 'completed',
              reviewId: 'review-1',
              approved: false,
            },
          },
          {
            status: 'handled',
            result: {
              status: 'completed',
              reviewId: 'review-1',
              approved: false,
              feedback: '',
            },
          },
        ],
        [
          {
            status: 'handled',
            result: { status: 'completed', reviewId: 1, approved: false },
          },
          {
            status: 'error',
            error: 'Plannotator returned an invalid status result',
          },
        ],
      ];

      // when
      const results = await Promise.all(
        scenarios.map(([response]) =>
          requestPlannotatorReviewStatus(
            respondingEvents(response),
            'request',
            'review-1',
            100,
          ),
        ),
      );

      // then
      expect(results).toEqual(scenarios.map(([, expected]) => expected));
    });

    test('parses pushed results and reports request timeouts', async () => {
      // given
      const silentEvents = {
        on: () => () => undefined,
        emit: () => undefined,
      };
      const keepAlive = setInterval(() => undefined, 100);

      // when
      const [start, status] = await Promise.all([
        requestPlannotatorReview(
          silentEvents,
          'request-start',
          '# Plan',
          'test',
          1,
        ),
        requestPlannotatorReviewStatus(
          silentEvents,
          'request-status',
          'review-1',
          1,
        ),
      ]);
      clearInterval(keepAlive);

      // then
      expect(start).toEqual({
        status: 'unavailable',
        error: 'Plannotator did not respond within 1ms',
      });
      expect(status).toEqual({
        status: 'unavailable',
        error: 'Plannotator did not respond within 1ms',
      });
      expect(parsePlannotatorResult(null)).toBe(undefined);
      expect(parsePlannotatorResult({ reviewId: 1, approved: true })).toBe(
        undefined,
      );
      expect(
        parsePlannotatorResult({ reviewId: 'review-1', approved: true }),
      ).toEqual({
        reviewId: 'review-1',
        approved: true,
        feedback: '',
      });
    });

    test('uses injected timer boundaries', async () => {
      // given
      const scheduledTimeouts: Array<number> = [];
      const cancelledTimers = new Set<ReturnType<typeof setTimeout>>();
      const dependencies = {
        scheduleTimeout: (callback: () => void, timeoutMs: number) => {
          scheduledTimeouts.push(timeoutMs);
          return setTimeout(callback, 60_000);
        },
        cancelTimeout: (timer: ReturnType<typeof setTimeout>) => {
          cancelledTimers.add(timer);
          clearTimeout(timer);
        },
      };

      // when
      const response = await requestPlannotatorReview(
        respondingEvents({
          status: 'handled',
          result: { status: 'pending', reviewId: 'injected-review' },
        }),
        'injected-request',
        '# Plan',
        'test',
        250,
        dependencies,
      );

      // then
      expect(response.status).toBe('handled');
      expect(scheduledTimeouts).toEqual([250]);
      expect(cancelledTimers.size).toBe(1);
    });
  });
});
