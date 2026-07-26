import { describe, expect, test } from 'bun:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  registerHarnessCommands,
  type WorkflowCommandController,
} from '../src/commands.ts';

describe('when testing commands', () => {
  type Handler = (
    args: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;

  describe('should satisfy its behavioral contract', () => {
    test('registers commands, forwards trimmed arguments, and completes workflow ids', async () => {
      // given
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
        doctor: async (id) => void calls.push(['doctor', id]),
        start: async (id, input) => void calls.push(['start', id, input]),
        pause: async (reason) => void calls.push(['pause', reason]),
        resume: async (input) => void calls.push(['resume', input]),
        abort: async (reason) => void calls.push(['abort', reason]),
        reload: async () => void calls.push(['reload']),
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

      // when
      registerHarnessCommands(pi, controller);

      // then
      expect(
        commands.get('workflow-start')?.getArgumentCompletions?.('de'),
      ).toEqual([
        { value: 'deploy', label: 'deploy' },
        { value: 'demo', label: 'demo' },
      ]);
      expect(
        commands.get('workflow-start')?.getArgumentCompletions?.('x'),
      ).toBe(null);
      expect(
        commands.get('workflow-doctor')?.getArgumentCompletions?.('de'),
      ).toEqual([
        { value: 'deploy', label: 'deploy' },
        { value: 'demo', label: 'demo' },
      ]);
      expect(
        commands.get('workflow-doctor')?.getArgumentCompletions?.('x'),
      ).toBe(null);
      await commands
        .get('workflow-start')!
        .handler('  deploy  --dry-run ', context);
      await commands.get('workflow-start')!.handler('   ', context);
      await commands.get('workflow-list')!.handler('', context);
      await commands.get('workflow-doctor')!.handler('  demo  ', context);
      await commands.get('workflow-pause')!.handler('  later  ', context);
      await commands
        .get('workflow-resume')!
        .handler('  use the existing cache  ', context);
      await commands.get('workflow-abort')!.handler('  stop  ', context);
      await commands.get('workflow-reload')!.handler('', context);

      expect(calls).toEqual([
        ['start', 'deploy', '--dry-run'],
        ['notify', 'Usage: /workflow-start <id> [input]', 'warning'],
        ['list'],
        ['doctor', 'demo'],
        ['pause', 'later'],
        ['resume', 'use the existing cache'],
        ['abort', 'stop'],
        ['reload'],
      ]);
      expect(commands.has('workflow-status')).toBe(false);
    });
  });
});
