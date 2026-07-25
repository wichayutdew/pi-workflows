import { describe, expect, test } from 'bun:test';
import { requestPromptGateReview } from '../src/integrations/prompt-gate.ts';

describe('when testing prompt gate', () => {
  function ui(
    selectResponses: Array<string | undefined>,
    inputResponses: Array<string | undefined>,
  ) {
    const notices: Array<[string, string]> = [];
    return {
      value: {
        select: async () => selectResponses.shift(),
        input: async () => inputResponses.shift(),
        notify: (message: string, type: string) =>
          notices.push([message, type]),
      },
      notices,
    };
  }

  describe('should satisfy its behavioral contract', () => {
    test('resolves approval and dismisses paused or cancelled reviews', async () => {
      // given
      // when
      const approved = ui(['Approve'], []);
      // then
      expect(
        await requestPromptGateReview(
          approved.value as never,
          'Review',
          'artifact',
        ),
      ).toEqual({ status: 'resolved', approved: true, feedback: '' });
      const dismissed = ui(['Pause workflow'], []);
      expect(
        await requestPromptGateReview(
          dismissed.value as never,
          'Review',
          'artifact',
        ),
      ).toEqual({ status: 'dismissed' });
    });

    test('requires non-empty change feedback and handles cancellation', async () => {
      // given
      // when
      const changes = ui(['Request changes'], ['  ', ' revise this ']);
      // then
      expect(
        await requestPromptGateReview(
          changes.value as never,
          'Review',
          'artifact',
        ),
      ).toEqual({
        status: 'resolved',
        approved: false,
        feedback: 'revise this',
      });
      expect(changes.notices).toEqual([
        ['Feedback cannot be empty', 'warning'],
      ]);
      const cancelled = ui(['Request changes'], [undefined]);
      expect(
        await requestPromptGateReview(
          cancelled.value as never,
          'Review',
          'artifact',
        ),
      ).toEqual({ status: 'dismissed' });
    });
  });
});
