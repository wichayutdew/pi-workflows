import { describe, expect, test } from 'bun:test';
import { SerialTaskQueue } from '../src/runtime/serial-task-queue.ts';

describe('when testing serial task queue', () => {
  describe('should satisfy its behavioral contract', () => {
    test('serial task queue does not overlap state-changing commands', async () => {
      // given
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

      // when
      await Promise.resolve();
      // then
      expect(events).toEqual(['first:start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    test('serial task queue continues after a command rejects', async () => {
      // given
      // when
      const queue = new SerialTaskQueue();
      // then
      await expect(
        queue.run(async () => {
          throw new Error('expected');
        }),
      ).rejects.toThrow();
      expect(await queue.run(async () => 'continued')).toBe('continued');
    });
  });
});
