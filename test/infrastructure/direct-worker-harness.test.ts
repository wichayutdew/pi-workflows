import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { WorkflowHarness } from '../../src/harness.ts';
import type { WorkflowHarnessDependencies } from '../../src/infrastructure/harness/dependencies.ts';
import type { SubagentDelegationClientController } from '../../src/infrastructure/process/subagent-client.ts';
import { extractChildPolicy } from '../../src/domain/index.ts';

type LifecycleHandler = (
  event: Record<string, unknown>,
  context: ExtensionContext,
) => unknown;
type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

const eventually = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('workflow did not settle');
};

describe('when running a workflow through a direct Pi worker', () => {
  test('loads, starts, completes, and cleans up a delegated step', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-direct-'));
    const previousDirectory = process.env.PI_WORKFLOWS_DIR;
    process.env.PI_WORKFLOWS_DIR = directory;
    const commands = new Map<string, CommandHandler>();
    const lifecycle = new Map<string, LifecycleHandler>();
    const notifications: string[] = [];
    const activeTools: Array<ReadonlyArray<string>> = [];
    const checkpoints: unknown[] = [];
    let activeRequestId: string | undefined;
    let result = '';
    let removed = false;
    let delegateCount = 0;
    let settlePending:
      | ((response: {
          requestId: string;
          agent: string;
          status: 'cancelled';
        }) => void)
      | undefined;
    const subagents: SubagentDelegationClientController = {
      get activeRequestId() {
        return activeRequestId;
      },
      async delegate(request) {
        activeRequestId = request.requestId;
        delegateCount += 1;
        if (delegateCount === 3 || delegateCount === 7) {
          return new Promise((resolve) => {
            settlePending = resolve;
          });
        }
        if (delegateCount === 5) {
          return {
            requestId: request.requestId,
            agent: request.agent,
            status: 'failed' as const,
            error: 'worker failure',
          };
        }
        const policy = extractChildPolicy(request.task);
        if (!policy) throw new Error('worker task has no policy');
        result = JSON.stringify({
          version: 1,
          policyDigest: policy.policy.policyDigest,
          outcome: 'done',
          summary:
            '# Done: Worker completed the step.\n**Completed:**\n- Completed the delegated work in `src/example.ts`.\n**Remaining:**\n- None; workflow is complete.',
        });
        return {
          requestId: request.requestId,
          agent: request.agent,
          status: 'completed',
          exitCode: 0,
        };
      },
      async cancelActiveAndWait() {
        if (activeRequestId && settlePending) {
          settlePending({
            requestId: activeRequestId,
            agent: 'worker',
            status: 'cancelled',
          });
          settlePending = undefined;
        }
        activeRequestId = undefined;
        return true;
      },
    };
    const context = {
      cwd: directory,
      hasUI: true,
      mode: 'tui',
      isProjectTrusted: () => true,
      isIdle: () => true,
      waitForIdle: async () => undefined,
      abort: () => undefined,
      getSystemPrompt: () => '',
      getSystemPromptOptions: () => ({ skills: [] }),
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        getHeader: () => undefined,
        getSessionFile: () => join(directory, 'session.jsonl'),
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => undefined,
        setWidget: () => undefined,
        custom: async () => undefined,
      },
    } as unknown as ExtensionCommandContext;
    const pi = {
      on(event: string, handler: LifecycleHandler) {
        lifecycle.set(event, handler);
      },
      registerCommand(name: string, command: { handler: CommandHandler }) {
        commands.set(name, command.handler);
      },
      registerShortcut() {},
      registerTool() {},
      getCommands: () => [],
      getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }],
      getActiveTools: () => ['read'],
      setActiveTools: (tools: string[]) => activeTools.push(tools),
      appendEntry: (_type: string, data: unknown) => checkpoints.push(data),
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      events: { on: () => () => undefined, emit: () => undefined },
    } as unknown as ExtensionAPI;
    const dependencies: Partial<WorkflowHarnessDependencies> = {
      createSubagentClient: () => subagents,
      readDelegatedResult: async () => result,
      removeDelegationWorkspace: async () => {
        removed = true;
      },
      createDelegationWorkspace: () => ({
        resultDirectory: join(tmpdir(), 'pi-workflows-step-direct-test'),
        capabilityPath: join(
          tmpdir(),
          'pi-workflows-step-direct-test',
          'capability',
        ),
        capabilityToken: 'a'.repeat(64),
        resultPath: join(
          tmpdir(),
          'pi-workflows-step-direct-test',
          'result.json',
        ),
      }),
      createRequestId: () => 'request-1',
      now: () => 1,
    };

    try {
      await writeFile(
        join(directory, 'direct.workflow.yaml'),
        [
          'version: 1',
          'id: direct',
          'command: direct',
          'description: Direct worker test',
          'start: implement',
          'steps:',
          '  implement:',
          '    agent: worker',
          '    prompt: Complete {{workflow.input}}',
          '    permissions:',
          '      tools: [read]',
          '    requires:',
          '      tools: [read]',
          '    transitions:',
          '      done: $done',
        ].join('\n'),
      );
      new WorkflowHarness(pi, 'ctrl+alt+w', dependencies);
      await lifecycle.get('session_start')?.(
        { type: 'session_start' },
        context,
      );
      const start = commands.get('workflow-start');
      expect(start).toBeDefined();
      await start?.('direct ship it', context);

      await eventually(() => removed || notifications.length > 1);
      expect(removed, notifications.join('\n')).toBe(true);
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(activeTools).toContainEqual([]);
      expect(notifications.join('\n')).toContain('completed');
      await commands.get('workflow-status')?.('', context);

      await commands.get('workflow-list')?.('', context);
      await commands.get('workflow-doctor')?.('direct', context);
      await commands.get('workflow-restart')?.('ship a follow-up', context);
      await eventually(
        () =>
          notifications.filter((message) => message.includes('completed'))
            .length === 2,
      );
      expect(checkpoints.length).toBeGreaterThan(1);

      await commands.get('workflow-restart')?.('pause and resume', context);
      await eventually(() => delegateCount === 3);
      await commands.get('workflow-pause')?.('hold for review', context);
      await commands.get('workflow-resume')?.('continue now', context);
      await eventually(
        () =>
          notifications.filter((message) => message.includes('completed'))
            .length === 3,
      );
      expect(delegateCount).toBe(4);

      await commands.get('workflow-restart')?.('exercise failure', context);
      await eventually(() =>
        notifications.some((message) => message.includes('paused')),
      );
      expect(notifications.join('\n')).toContain('worker failure');

      await lifecycle.get('session_tree')?.({ type: 'session_tree' }, context);
      const inputResult = await lifecycle.get('input')?.(
        { source: 'user', text: '/direct\nstarted from multiline input' },
        context,
      );
      expect(inputResult).toEqual({ action: 'handled' });
      await eventually(
        () =>
          notifications.filter((message) => message.includes('completed'))
            .length === 4,
      );
      await lifecycle.get('session_shutdown')?.(
        { type: 'session_shutdown' },
        context,
      );

      await lifecycle.get('session_start')?.(
        { type: 'session_start' },
        context,
      );
      await commands.get('workflow-start')?.('direct abort this run', context);
      await eventually(() => delegateCount === 7);
      await commands.get('workflow-abort')?.('cancel test worker', context);
      expect(notifications.join('\n')).toContain('Aborted workflow');
    } finally {
      if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
      else process.env.PI_WORKFLOWS_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
