import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialTaskQueue } from '../src/runtime/serial-task-queue.ts';

test('serial task queue does not overlap state-changing commands', async () => {
  const queue = new SerialTaskQueue();
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push('first:start');
    await firstBlocked;
    events.push('first:end');
  });
  const second = queue.run(async () => {
    events.push('second:start');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('serial task queue continues after a command rejects', async () => {
  const queue = new SerialTaskQueue();
  await assert.rejects(
    queue.run(async () => {
      throw new Error('expected');
    }),
  );
  assert.equal(await queue.run(async () => 'continued'), 'continued');
});
