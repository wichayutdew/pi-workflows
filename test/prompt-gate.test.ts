import assert from 'node:assert/strict';
import test from 'node:test';
import { requestPromptGateReview } from '../src/integrations/prompt-gate.ts';

function ui(
  selectResponses: Array<string | undefined>,
  inputResponses: Array<string | undefined>,
) {
  const notices: Array<[string, string]> = [];
  return {
    value: {
      select: async () => selectResponses.shift(),
      input: async () => inputResponses.shift(),
      notify: (message: string, type: string) => notices.push([message, type]),
    },
    notices,
  };
}

test('resolves approval and dismisses paused or cancelled reviews', async () => {
  const approved = ui(['Approve'], []);
  assert.deepEqual(
    await requestPromptGateReview(
      approved.value as never,
      'Review',
      'artifact',
    ),
    { status: 'resolved', approved: true, feedback: '' },
  );
  const dismissed = ui(['Pause workflow'], []);
  assert.deepEqual(
    await requestPromptGateReview(
      dismissed.value as never,
      'Review',
      'artifact',
    ),
    { status: 'dismissed' },
  );
});

test('requires non-empty change feedback and handles cancellation', async () => {
  const changes = ui(['Request changes'], ['  ', ' revise this ']);
  assert.deepEqual(
    await requestPromptGateReview(changes.value as never, 'Review', 'artifact'),
    { status: 'resolved', approved: false, feedback: 'revise this' },
  );
  assert.deepEqual(changes.notices, [['Feedback cannot be empty', 'warning']]);
  const cancelled = ui(['Request changes'], [undefined]);
  assert.deepEqual(
    await requestPromptGateReview(
      cancelled.value as never,
      'Review',
      'artifact',
    ),
    { status: 'dismissed' },
  );
});
