import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import {
  createSubagentDelegationClient,
  type DirectWorkerSpawn,
} from '../src/integrations/subagents/client.ts';

type FakeWorker = EventEmitter & {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
};

function worker(): FakeWorker {
  const child = new EventEmitter() as FakeWorker;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  return child;
}

const request = {
  version: 1 as const,
  requestId: 'direct-worker',
  agent: 'worker',
  task: 'Complete the workflow step',
  cwd: '/workspace',
};

describe('when running a direct workflow worker', () => {
  test('streams safe progress and resolves the correlated terminal response', async () => {
    const child = worker();
    const calls: Array<readonly unknown[]> = [];
    const spawnWorker: DirectWorkerSpawn = ((...args: unknown[]) => {
      calls.push(args);
      return child as unknown as ChildProcess;
    }) as DirectWorkerSpawn;
    const updates: Array<Record<string, unknown>> = [];
    const client = createSubagentDelegationClient(spawnWorker);

    const pending = client.delegate(request, {
      onUpdate: (update) => updates.push(update),
    });
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"agent_start"}\n{"type":"tool_execution_start","toolName":"read","args":{"path":"README.md"}}\n',
      ),
    );
    child.stderr.emit('data', Buffer.from('MCP startup notice'));
    child.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({
      requestId: 'direct-worker',
      agent: 'worker',
      status: 'completed',
      exitCode: 0,
    });
    expect(calls[0]?.slice(0, 2)).toEqual([
      'pi',
      ['--no-session', '--mode', 'json', '--print', request.task],
    ]);
    expect(updates).toEqual([
      { requestId: request.requestId, activity: 'thinking', toolCount: 0 },
      {
        requestId: request.requestId,
        currentTool: 'read',
        detail: 'call read {"path":"README.md"}',
        toolCount: 1,
      },
    ]);
    expect(client.activeRequestId).toBeUndefined();
  });

  test('rejects spawn failures and waits for cancellation to close', async () => {
    const child = worker();
    let killed = 0;
    child.kill = () => {
      killed += 1;
      return true;
    };
    const client = createSubagentDelegationClient(
      (() => child as unknown as ChildProcess) as DirectWorkerSpawn,
    );
    const pending = client.delegate(request);
    const cancellation = client.cancelActiveAndWait();
    child.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    await expect(cancellation).resolves.toBe(true);
    expect(killed).toBe(1);

    const failedClient = createSubagentDelegationClient((() => {
      const failed = worker();
      queueMicrotask(() => failed.emit('error', new Error('missing pi')));
      return failed as unknown as ChildProcess;
    }) as DirectWorkerSpawn);
    await expect(failedClient.delegate(request)).rejects.toThrow('missing pi');
  });
});
