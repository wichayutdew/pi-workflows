import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidCompletionCallIds } from '../src/policy/completion-batch.ts';

const completionTool = 'workflow_complete_step';

function assistantMessage(
  calls: Array<{ id: string; name: string }>,
): Record<string, unknown> {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      ...call,
      arguments: {},
    })),
  };
}

test('accepts completion only as the sole tool call', () => {
  assert.deepEqual(
    [
      ...invalidCompletionCallIds(
        assistantMessage([{ id: 'complete', name: completionTool }]),
        completionTool,
      ),
    ],
    [],
  );
});

test('rejects completion anywhere in a mixed or duplicate batch', () => {
  assert.deepEqual(
    [
      ...invalidCompletionCallIds(
        assistantMessage([
          { id: 'complete', name: completionTool },
          { id: 'read', name: 'read' },
        ]),
        completionTool,
      ),
    ],
    ['complete'],
  );
  assert.deepEqual(
    [
      ...invalidCompletionCallIds(
        assistantMessage([
          { id: 'read', name: 'read' },
          { id: 'complete-1', name: completionTool },
          { id: 'complete-2', name: completionTool },
        ]),
        completionTool,
      ),
    ],
    ['complete-1', 'complete-2'],
  );
});
