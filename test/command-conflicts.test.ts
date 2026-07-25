import { describe, expect, test } from 'bun:test';
import { hasRuntimeCommandConflict } from '../src/config/command-conflicts.ts';

describe('when testing command conflicts', () => {
  describe('should satisfy its behavioral contract', () => {
    test('detects commands owned by another loaded resource', () => {
      // given
      // when
      // then
      expect(
        hasRuntimeCommandConflict('fix', [{ name: 'fix' }], new Set()),
      ).toBe(true);
      expect(
        hasRuntimeCommandConflict(
          'fix',
          [{ name: 'fix:1' }, { name: 'fix:2' }],
          new Set(['fix']),
        ),
      ).toBe(true);
    });

    test('allows this harness to refresh its own workflow alias', () => {
      // given
      // when
      // then
      expect(
        hasRuntimeCommandConflict('fix', [{ name: 'fix' }], new Set(['fix'])),
      ).toBe(false);
    });
  });
});
