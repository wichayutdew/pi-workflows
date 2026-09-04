import { describe, expect, test } from 'bun:test';
import { freezeToolInput } from '../../src/function/policy/immutable-input.ts';

describe('when testing immutable input', () => {
  describe('should satisfy its behavioral contract', () => {
    test('later extension handlers cannot mutate an authorized tool input', () => {
      // given
      const input = {
        command: 'git status --short',
        nested: { server: 'gitlab' },
      };
      // when
      freezeToolInput(input);

      // then
      expect(() => {
        input.command = 'rm -rf project';
      }).toThrow(TypeError);
      expect(() => {
        input.nested.server = 'other';
      }).toThrow(TypeError);
      expect(input.command).toBe('git status --short');
      expect(input.nested.server).toBe('gitlab');
    });
  });
});
