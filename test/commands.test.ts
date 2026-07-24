import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  registerHarnessCommands,
  type WorkflowCommandController,
} from '../src/commands.ts';

type Handler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

test('registers commands, forwards trimmed arguments, and completes workflow ids', async () => {
  const commands = new Map<
    string,
    {
      handler: Handler;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >();
  const calls: Array<[string, ...string[]]> = [];
  const context = {
    ui: {
      notify(message: string, type: string) {
        calls.push(['notify', message, type]);
      },
    },
  } as unknown as ExtensionCommandContext;
  const controller: WorkflowCommandController = {
    workflowIds: () => ['deploy', 'demo'],
    list: async () => void calls.push(['list']),
    start: async (id, input) => void calls.push(['start', id, input]),
    pause: async (reason) => void calls.push(['pause', reason]),
    resume: async () => void calls.push(['resume']),
    abort: async (reason) => void calls.push(['abort', reason]),
    reload: async () => void calls.push(['reload']),
    status: async () => void calls.push(['status']),
  };
  const pi = {
    registerCommand(
      name: string,
      command: {
        handler: Handler;
        getArgumentCompletions?: (prefix: string) => unknown;
      },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  registerHarnessCommands(pi, controller);

  assert.deepEqual(
    commands.get('workflow-start')?.getArgumentCompletions?.('de'),
    [
      { value: 'deploy', label: 'deploy' },
      { value: 'demo', label: 'demo' },
    ],
  );
  assert.equal(
    commands.get('workflow-start')?.getArgumentCompletions?.('x'),
    null,
  );
  await commands
    .get('workflow-start')!
    .handler('  deploy  --dry-run ', context);
  await commands.get('workflow-start')!.handler('   ', context);
  await commands.get('workflow-list')!.handler('', context);
  await commands.get('workflow-pause')!.handler('  later  ', context);
  await commands.get('workflow-resume')!.handler('', context);
  await commands.get('workflow-abort')!.handler('  stop  ', context);
  await commands.get('workflow-reload')!.handler('', context);
  await commands.get('workflow-status')!.handler('', context);

  assert.deepEqual(calls, [
    ['start', 'deploy', '--dry-run'],
    ['notify', 'Usage: /workflow-start <id> [input]', 'warning'],
    ['list'],
    ['pause', 'later'],
    ['resume'],
    ['abort', 'stop'],
    ['reload'],
    ['status'],
  ]);
});
