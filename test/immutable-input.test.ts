import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeToolInput } from '../src/policy/immutable-input.ts';

test('later extension handlers cannot mutate an authorized tool input', () => {
  const input = {
    command: 'git status --short',
    nested: { server: 'gitlab' },
  };
  freezeToolInput(input);

  assert.throws(() => {
    input.command = 'rm -rf project';
  }, TypeError);
  assert.throws(() => {
    input.nested.server = 'other';
  }, TypeError);
  assert.equal(input.command, 'git status --short');
  assert.equal(input.nested.server, 'gitlab');
});
