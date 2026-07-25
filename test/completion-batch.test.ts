import { describe, expect, test } from 'bun:test';
import { invalidCompletionCallIds } from '../src/policy/completion-batch.ts';

describe('when testing completion batch', () => {
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

  describe('should satisfy its behavioral contract', () => {
    test('accepts completion only as the sole tool call', () => {
      // given
      // when
      // then
      expect([
        ...invalidCompletionCallIds(
          assistantMessage([{ id: 'complete', name: completionTool }]),
          completionTool,
        ),
      ]).toEqual([]);
    });

    test('rejects completion anywhere in a mixed or duplicate batch', () => {
      // given
      // when
      // then
      expect([
        ...invalidCompletionCallIds(
          assistantMessage([
            { id: 'complete', name: completionTool },
            { id: 'read', name: 'read' },
          ]),
          completionTool,
        ),
      ]).toEqual(['complete']);
      expect([
        ...invalidCompletionCallIds(
          assistantMessage([
            { id: 'read', name: 'read' },
            { id: 'complete-1', name: completionTool },
            { id: 'complete-2', name: completionTool },
          ]),
          completionTool,
        ),
      ]).toEqual(['complete-1', 'complete-2']);
    });
  });
});
