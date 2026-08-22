import { describe, expect, test } from 'bun:test';
import { classifyRecoverySafety } from '../src/integrations/subagents/diagnostics.ts';
import { shouldRetryMissingCompletion } from '../src/harness/delegation-recovery.ts';

describe('when classifying missing delegated completions', () => {
  test('allows fresh recovery only after a complete read-only transcript', () => {
    expect(
      classifyRecoverySafety({
        settled: true,
        truncated: false,
        calls: [
          { id: 'read-1', name: 'read', state: 'completed' },
          { id: 'complete-1', name: 'structured_output', state: 'completed' },
        ],
      }),
    ).toBe('read-only');
  });

  test.each(['bash', 'edit', 'write', 'mcp', 'unknown'])(
    'rejects %s as mutation-capable or unknown',
    (name) => {
      expect(
        classifyRecoverySafety({
          settled: true,
          truncated: false,
          calls: [{ id: `${name}-1`, name, state: 'completed' }],
        }),
      ).toBe('unsafe');
    },
  );

  test('permits exactly one fresh retry after repaired read-only evidence', () => {
    const diagnostic = {
      settled: true,
      truncated: false,
      calls: [{ id: 'read-1', name: 'read', state: 'completed' as const }],
    };
    expect(shouldRetryMissingCompletion(diagnostic, 1)).toBe(true);
    expect(shouldRetryMissingCompletion(diagnostic, 2)).toBe(false);
  });

  test('rejects incomplete or failed evidence', () => {
    expect(
      classifyRecoverySafety({ settled: false, truncated: false, calls: [] }),
    ).toBe('incomplete');
    expect(
      classifyRecoverySafety({
        settled: true,
        truncated: true,
        calls: [],
      }),
    ).toBe('incomplete');
    expect(
      classifyRecoverySafety({
        settled: true,
        truncated: false,
        calls: [{ id: 'read-1', name: 'read', state: 'failed' }],
      }),
    ).toBe('unsafe');
  });
});
