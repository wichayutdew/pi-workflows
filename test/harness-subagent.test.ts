import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component, KeyId } from '@earendil-works/pi-tui';
import { WorkflowHarness } from '../src/harness.ts';
import { loadCatalog } from '../src/config/load.ts';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import { pauseRun } from '../src/engine/transitions.ts';
import type { WorkflowHarnessDependencies } from '../src/harness/dependencies.ts';
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_RESULT_CHANNEL,
} from '../src/integrations/plannotator.ts';
import { auditCompletedDelegationTranscript } from '../src/integrations/subagents/diagnostics.ts';
import {
  extractChildPolicy,
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type ChildStepPolicy,
  type SubagentDelegationRequest,
} from '../src/integrations/subagents/protocol.ts';
import { expectTruthy } from './helpers.ts';

describe('when testing harness subagent', () => {
  type LifecycleHandler = (
    event: Record<string, unknown>,
    context: ExtensionContext,
  ) => unknown;

  type CommandHandler = (
    args: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;

  type ShortcutHandler = (context: ExtensionContext) => Promise<void> | void;

  interface RegisteredTool {
    name: string;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<unknown>;
  }

  class FakeEventBus {
    private readonly handlers = new Map<
      string,
      Set<(data: unknown) => unknown>
    >();

    on(event: string, handler: (data: unknown) => unknown): () => void {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return () => handlers.delete(handler);
    }

    emit(event: string, data: unknown): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) {
        void handler(data);
      }
    }
  }

  interface HarnessFixture {
    pi: ExtensionAPI;
    context: ExtensionCommandContext;
    events: FakeEventBus;
    lifecycle: Map<string, LifecycleHandler[]>;
    commands: Map<string, CommandHandler>;
    shortcuts: Map<string, ShortcutHandler>;
    tools: Map<string, RegisteredTool>;
    checkpoints: Array<{ type: string; data: unknown }>;
    sentMessages: Array<{
      customType: string;
      content: unknown;
      display?: boolean;
    }>;
    sentUserMessages: string[];
    notifications: Array<{
      message: string;
      type: 'info' | 'warning' | 'error' | undefined;
    }>;
    customRenders: string[][];
    customOptions: Array<Record<string, unknown>>;
    repaintRequests: Array<boolean | undefined>;
    statusUpdates: Array<{ key: string; value: string | undefined }>;
    widgetUpdates: Array<{
      key: string;
      lines: string[] | undefined;
      options?: { placement?: string };
    }>;
    selectResponses: Array<string | undefined>;
    inputResponses: Array<string | undefined>;
    activeTools: () => string[];
    setMode(value: ExtensionContext['mode']): void;
    setIdle(value: boolean): void;
    abortCount: () => number;
    waitForIdleCount: () => number;
  }

  function createHarnessFixture(
    cwd: string,
    sessionBranch: Array<Record<string, unknown>> = [],
  ): HarnessFixture {
    const events = new FakeEventBus();
    const lifecycle = new Map<string, LifecycleHandler[]>();
    const commands = new Map<string, CommandHandler>();
    const shortcuts = new Map<string, ShortcutHandler>();
    const tools = new Map<string, RegisteredTool>();
    const checkpoints: Array<{ type: string; data: unknown }> = [];
    const sentMessages: Array<{
      customType: string;
      content: unknown;
      display?: boolean;
    }> = [];
    const sentUserMessages: string[] = [];
    const notifications: HarnessFixture['notifications'] = [];
    const customRenders: string[][] = [];
    const customOptions: Array<Record<string, unknown>> = [];
    const repaintRequests: Array<boolean | undefined> = [];
    const statusUpdates: HarnessFixture['statusUpdates'] = [];
    const widgetUpdates: HarnessFixture['widgetUpdates'] = [];
    const selectResponses: Array<string | undefined> = [];
    const inputResponses: Array<string | undefined> = [];
    let activeTools = ['read', 'bash'];
    let idle = true;
    let abortCount = 0;
    let waitForIdleCount = 0;
    type CustomFactory = (
      tui: { requestRender(force?: boolean): void },
      theme: Theme,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => Component | Promise<Component>;
    type WidgetFactory = (
      tui: { requestRender(force?: boolean): void },
      theme: Theme,
    ) => Component & { dispose?(): void };
    const theme = {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    } as unknown as Theme;
    const ui = {
      notify(message: string, type: 'info' | 'warning' | 'error' | undefined) {
        notifications.push({ message, type });
      },
      setStatus(key: string, value: string | undefined) {
        statusUpdates.push({ key, value });
      },
      setWidget(
        key: string,
        content: string[] | WidgetFactory | undefined,
        options?: { placement?: string },
      ) {
        const lines =
          typeof content === 'function'
            ? content({ requestRender() {} }, theme).render(80)
            : content
              ? [...content]
              : undefined;
        widgetUpdates.push({
          key,
          lines,
          ...(options ? { options } : {}),
        });
      },
      select: async () => selectResponses.shift(),
      input: async () => inputResponses.shift(),
      custom: async (
        factory: CustomFactory,
        options?: Record<string, unknown>,
      ) =>
        new Promise<unknown>((resolve, reject) => {
          customOptions.push(options ?? {});
          const tui = {
            requestRender(force?: boolean) {
              repaintRequests.push(force);
            },
          };
          Promise.resolve(factory(tui, theme, {}, resolve)).then(
            (component) => {
              customRenders.push(component.render(120));
              component.handleInput?.('q');
            },
            reject,
          );
        }),
    };
    const context = {
      cwd,
      ui,
      hasUI: true,
      mode: 'tui',
      isProjectTrusted: () => true,
      isIdle: () => idle,
      abort() {
        abortCount += 1;
        idle = true;
      },
      waitForIdle: async () => {
        waitForIdleCount += 1;
      },
      getSystemPrompt: () => '',
      getSystemPromptOptions: () => ({ skills: [] }),
      sessionManager: {
        getBranch: () => sessionBranch,
        getSessionFile: () => join(cwd, 'sessions.jsonl'),
      },
    } as unknown as ExtensionCommandContext;
    const pi = {
      events,
      on(event: string, handler: LifecycleHandler) {
        lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
      },
      registerCommand(name: string, command: { handler: CommandHandler }) {
        commands.set(name, command.handler);
      },
      registerShortcut(
        shortcut: string,
        options: { handler: ShortcutHandler },
      ) {
        shortcuts.set(shortcut, options.handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      getCommands() {
        return [...commands.keys()].map((name) => ({
          name,
          sourceInfo: {
            source: 'extension',
            path: '/pi-workflows/src/index.ts',
          },
        }));
      },
      getAllTools() {
        return [
          { name: 'read', sourceInfo: { source: 'builtin' } },
          { name: 'bash', sourceInfo: { source: 'builtin' } },
          {
            name: 'subagent',
            sourceInfo: {
              source: 'extension',
              path: '/node_modules/pi-subagents/index.ts',
            },
          },
          {
            name: 'plannotator_plan_review',
            sourceInfo: {
              source: 'extension',
              path: '/node_modules/@plannotator/pi-extension/index.ts',
            },
          },
          ...[...tools.keys()].map((name) => ({
            name,
            sourceInfo: {
              source: 'extension',
              path: '/pi-workflows/src/index.ts',
            },
          })),
        ];
      },
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(tools: string[]) {
        activeTools = [...tools];
      },
      appendEntry(type: string, data: unknown) {
        checkpoints.push({ type, data });
      },
      sendMessage(message: {
        customType: string;
        content: unknown;
        display?: boolean;
      }) {
        sentMessages.push(message);
      },
      sendUserMessage(content: string) {
        sentUserMessages.push(content);
      },
    } as unknown as ExtensionAPI;

    return {
      pi,
      context,
      events,
      lifecycle,
      commands,
      shortcuts,
      tools,
      checkpoints,
      sentMessages,
      sentUserMessages,
      notifications,
      customRenders,
      customOptions,
      repaintRequests,
      statusUpdates,
      widgetUpdates,
      selectResponses,
      inputResponses,
      activeTools: () => [...activeTools],
      setMode(value) {
        (context as unknown as { mode: ExtensionContext['mode'] }).mode = value;
      },
      setIdle(value: boolean) {
        idle = value;
      },
      abortCount: () => abortCount,
      waitForIdleCount: () => waitForIdleCount,
    };
  }

  async function writeWorkflow(
    directory: string,
    description = 'Delegate one step',
    subagent: unknown = {},
    skills: string[] = [],
    bashMode?: 'unrestricted',
  ): Promise<void> {
    await writeFile(
      join(directory, 'delegate.workflow.yaml'),
      JSON.stringify({
        version: 1,
        id: 'delegate',
        command: 'delegate',
        description,
        start: 'inspect',
        steps: {
          inspect: {
            subagent,
            prompt: 'Inspect {{workflow.input}}.',
            permissions: {
              tools: ['read', ...(bashMode ? ['bash'] : [])],
              ...(skills.length > 0 ? { skills } : {}),
              ...(bashMode ? { bash: { mode: bashMode } } : {}),
            },
            requires: {
              tools: ['read'],
              ...(skills.length > 0 ? { skills } : {}),
            },
            transitions: {
              done: '$done',
              blocked: '$pause',
            },
          },
        },
      }),
    );
  }

  async function writeFailureSession(
    directory: string,
    runId: string,
    tool: string,
    argumentsValue: Record<string, unknown>,
    error: string,
  ): Promise<string> {
    const sessionDirectory = join(directory, 'sessions', runId, 'run-0');
    const sessionFile = join(sessionDirectory, 'session.jsonl');
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'failed-tool',
                name: tool,
                arguments: argumentsValue,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'toolResult',
            toolCallId: 'failed-tool',
            toolName: tool,
            isError: true,
            content: [{ type: 'text', text: error }],
          },
        }),
      ].join('\n'),
    );
    return sessionFile;
  }

  async function bindSessionToRequest(
    sessionFile: string,
    request: SubagentDelegationRequest,
  ): Promise<void> {
    const body = await readFile(sessionFile, 'utf8');
    const extracted = extractChildPolicy(request.task);
    expectTruthy(extracted);
    const initialPrompt = JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: extracted.task }],
      },
    });
    await writeFile(
      sessionFile,
      [initialPrompt, body].filter(Boolean).join('\n'),
    );
  }

  async function writeCompletedSession(
    directory: string,
    runId: string,
    request: SubagentDelegationRequest,
    warning?: string,
  ): Promise<string> {
    const sessionDirectory = join(directory, 'sessions', runId, 'run-0');
    const sessionFile = join(sessionDirectory, 'session.jsonl');
    const extracted = extractChildPolicy(request.task);
    expectTruthy(extracted);
    const entries: Array<Record<string, unknown>> = [
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: extracted.task }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'completed-result',
              name: 'structured_output',
              arguments: {
                value: {
                  outcome: 'done',
                  summary: 'Completed with correlated transcript evidence',
                },
              },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'completed-result',
          toolName: 'structured_output',
          isError: false,
          content: [{ type: 'text', text: 'Structured output captured.' }],
        },
      },
    ];
    if (warning) {
      entries.push({
        type: 'custom_message',
        customType: 'subagent_watchdog_warning',
        content: warning,
      });
    }
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionFile,
      entries.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    return sessionFile;
  }

  async function writeGatedWorkflow(directory: string): Promise<void> {
    await writeFile(
      join(directory, 'gated.workflow.yaml'),
      JSON.stringify({
        version: 1,
        id: 'gated',
        command: 'gated',
        description: 'Delegate a gated step',
        start: 'plan',
        steps: {
          plan: {
            subagent: {},
            prompt: 'Prepare a plan for {{workflow.input}}.',
            permissions: {
              tools: ['read'],
              extensions: ['plannotator'],
            },
            requires: {
              tools: ['read'],
              extensions: ['plannotator'],
            },
            gate: {
              provider: 'plannotator',
              submitOutcome: 'submit',
              approvedOutcome: 'approved',
              rejectedOutcome: 'changes-requested',
              timeoutMs: 1_000,
            },
            transitions: {
              approved: '$done',
              'changes-requested': 'plan',
              blocked: '$pause',
            },
          },
        },
      }),
    );
  }

  async function writeMainWorkflow(
    directory: string,
    gated = false,
  ): Promise<void> {
    await writeFile(
      join(directory, 'main.workflow.yaml'),
      JSON.stringify({
        version: 1,
        id: 'main',
        command: 'main-workflow',
        description: 'Run in the main agent',
        start: 'plan',
        steps: {
          plan: {
            prompt: 'Plan {{workflow.input}}. Feedback: {{gate.feedback}}',
            permissions: {
              tools: ['read'],
            },
            ...(gated
              ? {
                  gate: {
                    submitOutcome: 'submit',
                    approvedOutcome: 'approved',
                    rejectedOutcome: 'changes-requested',
                  },
                }
              : {}),
            transitions: gated
              ? {
                  approved: '$done',
                  'changes-requested': 'plan',
                  blocked: '$pause',
                }
              : {
                  done: '$done',
                  blocked: '$pause',
                },
          },
        },
      }),
    );
  }

  async function initialize(
    fixture: HarnessFixture,
    statusShortcut?: KeyId,
    dependencyOverrides: Partial<WorkflowHarnessDependencies> = {},
  ): Promise<WorkflowHarness> {
    const harness = new WorkflowHarness(fixture.pi, statusShortcut, {
      auditCompletedDelegationTranscript: async () => ({ verified: true }),
      ...dependencyOverrides,
    });
    await emitLifecycle(fixture, 'session_start', { type: 'session_start' });
    return harness;
  }

  async function emitLifecycle(
    fixture: HarnessFixture,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<unknown[]> {
    const handlers = fixture.lifecycle.get(event) ?? [];
    expectTruthy(handlers.length > 0);
    const results: unknown[] = [];
    for (const handler of handlers) {
      results.push(
        await handler(payload, fixture.context as unknown as ExtensionContext),
      );
    }
    return results;
  }

  async function eventually(assertion: () => void): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw lastError;
  }

  function latestRun(fixture: HarnessFixture): Record<string, unknown> {
    const checkpoint = fixture.checkpoints.at(-1);
    expectTruthy(checkpoint);
    return checkpoint.data as Record<string, unknown>;
  }

  describe('should satisfy its behavioral contract', () => {
    test('multiline workflow commands are redispatched instead of starting a parent turn', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-multiline-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
      try {
        await writeWorkflow(directory, 'Delegate one step', {}, ['planning']);
        const fixture = createHarnessFixture(directory);
        let delegatedRequest: SubagentDelegationRequest | undefined;
        let delegationRequests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          delegationRequests += 1;
          delegatedRequest = data as SubagentDelegationRequest;
          const extracted = extractChildPolicy(delegatedRequest.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Multiline workflow completed',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
            status: 'completed',
            warnings: ['Provider emitted a benign notice'],
          });
        });
        await initialize(fixture);
        const input = fixture.lifecycle.get('input')?.[0];
        expectTruthy(input);
        let eventIdle = false;
        let eventAborts = 0;
        const systemPrompt = [
          '<available_skills><name>obsolete</name></available_skills>',
          '<available_skills><skill><name> planning </name></skill></available_skills>',
        ].join('\n');
        const eventContext = {
          ...fixture.context,
          isIdle: () => eventIdle,
          abort() {
            eventAborts += 1;
            setTimeout(() => {
              eventIdle = true;
            }, 0);
          },
          getSystemPrompt: () => systemPrompt,
        } as unknown as Record<string, unknown>;
        delete eventContext.getSystemPromptOptions;
        delete eventContext.waitForIdle;

        const result = await input(
          {
            type: 'input',
            source: 'interactive',
            text: '/delegate\n"""inspect the repository"""',
          },
          eventContext as unknown as ExtensionContext,
        );

        // then
        expect(result).toEqual({ action: 'handled' });
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(delegatedRequest?.task).toContain(
          '"""inspect the repository"""',
        );
        expect(
          extractChildPolicy(delegatedRequest?.task ?? '')?.policy.permissions
            .skills,
        ).toEqual(['planning']);
        expect(eventAborts).toBe(1);
        expect(delegationRequests).toBe(1);
        expect(fixture.sentUserMessages).toEqual([]);
        expect(
          await input(
            {
              type: 'input',
              source: 'interactive',
              text: '/unknown\nleave this alone',
            },
            eventContext as unknown as ExtensionContext,
          ),
        ).toBe(undefined);

        const originalDateNow = Date.now;
        let timeoutResult: unknown;
        try {
          Date.now = () => Number.POSITIVE_INFINITY;
          timeoutResult = await input(
            {
              type: 'input',
              source: 'interactive',
              text: '/delegate\nthis start must time out',
            },
            {
              ...fixture.context,
              isIdle: () => false,
              abort() {},
              getSystemPrompt: () => systemPrompt,
            } as ExtensionContext,
          );
        } finally {
          Date.now = originalDateNow;
        }
        expect(timeoutResult).toEqual({ action: 'handled' });
        expect(delegationRequests).toBe(1);
        expect(fixture.notifications.at(-1)).toEqual({
          message:
            'Cannot start workflow: Timed out waiting for the interrupted Pi turn to stop',
          type: 'error',
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('reports catalog diagnostics and reloads idle workflows', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-diagnostics-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
      try {
        await writeWorkflow(directory);
        await writeFile(
          join(directory, 'second.workflow.yaml'),
          JSON.stringify({
            version: 1,
            id: 'second',
            command: 'second',
            description: 'Second workflow',
            start: 'run',
            steps: {
              run: {
                prompt: 'Run',
                transitions: { done: '$done' },
              },
            },
          }),
        );
        await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            writeFile(
              join(directory, `invalid-${index}.workflow.yaml`),
              '{ invalid',
            ),
          ),
        );
        const fixture = createHarnessFixture(directory);
        const harness = await initialize(fixture);
        const list = fixture.commands.get('workflow-list');
        const reload = fixture.commands.get('workflow-reload');
        expectTruthy(list);
        expectTruthy(reload);
        await list('', fixture.context);
        await reload('', fixture.context);

        // then
        expect(harness.workflowIds()).toEqual(['delegate', 'second']);
        expect(String(fixture.sentMessages.at(-1)?.content)).toMatch(
          /`delegate`[\s\S]*`second`/,
        );
        expect(
          fixture.notifications.map(({ message }) => message).join('\n'),
        ).toMatch(/1 more diagnostic/);
        expect(fixture.notifications.at(-1)?.message).toMatch(
          /Loaded 2 workflow\(s\)/,
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('workflow reload warns when a shortcut change needs Pi reload', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-shortcut-reload-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when / then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const reload = fixture.commands.get('workflow-reload');
        expectTruthy(reload);

        await writeFile(
          join(directory, 'settings.yaml'),
          'version: 1\nstatusShortcut: ctrl+shift+y\n',
        );
        await reload('', fixture.context);

        expect(fixture.shortcuts.has('ctrl+alt+w')).toBe(true);
        expect(fixture.shortcuts.has('ctrl+shift+y')).toBe(false);
        expect(fixture.notifications.at(-1)?.message).toMatch(
          /statusShortcut[\s\S]*\/reload/,
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('aborts workflows and handles session and policy lifecycle changes', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-lifecycle-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const harness = await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const abort = fixture.commands.get('workflow-abort');
        const reload = fixture.commands.get('workflow-reload');
        expectTruthy(start);
        expectTruthy(abort);
        expectTruthy(reload);
        await abort('', fixture.context);
        await start('inspect', fixture.context);
        const prompts = await emitLifecycle(fixture, 'before_agent_start', {
          systemPrompt: 'Base prompt',
          systemPromptOptions: { skills: [{ name: 'review' }] },
        });
        await reload('', fixture.context);
        (
          harness as unknown as {
            catalog: { workflows: Map<string, unknown> };
          }
        ).catalog.workflows.clear();
        await emitLifecycle(fixture, 'before_agent_start', {
          systemPrompt: 'Base prompt',
          systemPromptOptions: { skills: [] },
        });
        fixture.setIdle(false);
        await abort('stop now', fixture.context);
        await emitLifecycle(fixture, 'session_tree', {
          type: 'session_tree',
        });
        await emitLifecycle(fixture, 'session_shutdown', {
          type: 'session_shutdown',
        });

        const unconfirmed = createHarnessFixture(directory);
        const unconfirmedHarness = await initialize(unconfirmed);
        const unconfirmedStart = unconfirmed.commands.get('main-workflow');
        const unconfirmedAbort = unconfirmed.commands.get('workflow-abort');
        expectTruthy(unconfirmedStart);
        expectTruthy(unconfirmedAbort);
        await unconfirmedStart('inspect', unconfirmed.context);
        const unconfirmedInternal = unconfirmedHarness as unknown as {
          cancelActiveDelegation(reason: string): Promise<boolean>;
          catalog: { workflows: Map<string, unknown> };
        };
        unconfirmedInternal.cancelActiveDelegation = async () => false;
        await unconfirmedAbort(
          'stop without confirmation',
          unconfirmed.context,
        );

        // then
        expect(
          prompts.some(
            (result) =>
              typeof result === 'object' &&
              result !== null &&
              'systemPrompt' in result &&
              String(result.systemPrompt).includes(
                '# Active main-agent workflow',
              ),
          ),
        ).toBe(true);
        expect(
          fixture.notifications.map(({ message }) => message).join('\n'),
        ).toMatch(/No active workflow to abort/);
        expect(
          fixture.notifications.map(({ message }) => message).join('\n'),
        ).toMatch(/Pause the workflow before reloading/);
        expect(
          fixture.notifications.map(({ message }) => message).join('\n'),
        ).toMatch(/Aborted workflow "main"/);
        expect(unconfirmed.activeTools()).toEqual([]);
        expect(
          unconfirmed.notifications.some(({ message }) =>
            message.includes('has not confirmed cancellation'),
          ),
        ).toBe(true);
        expect(harness).toBeTruthy();
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('contains asynchronous boundary failures and reports them', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-boundaries-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
      try {
        const fixture = createHarnessFixture(directory);
        const harness = await initialize(fixture);
        interface FailureHooks {
          activePromptReview: unknown;
          finishDelegation(): Promise<void>;
          cleanupDelegation(): Promise<void>;
          pauseForDelegationFailure(reason: string): void;
          queueDelegationResponse(active: unknown, response: unknown): void;
          queueDelegationFailure(active: unknown, reason: string): void;
          launchPromptReview(
            workflow: unknown,
            run: unknown,
            context: unknown,
          ): void;
          finishPromptReview(): Promise<void>;
          queuePromptReviewResult(active: unknown, result: unknown): void;
          pausePromptGate(requestId: string, reason: string): void;
          queuePromptReviewFailure(active: unknown, reason: string): void;
          handlePlannotatorResult(data: unknown): Promise<void>;
        }
        const hooks = harness as unknown as FailureHooks;
        const ui = (
          fixture.context as unknown as {
            ui: { select(): Promise<string | undefined> };
          }
        ).ui;
        ui.select = async () => {
          throw new Error('review transport failed');
        };
        hooks.launchPromptReview(
          { definition: { id: 'boundary' } },
          {
            runId: 'run-boundary',
            pendingGate: {
              provider: 'prompt',
              requestId: 'review-boundary',
              stepId: 'plan',
              artifact: '# Plan',
            },
          },
          fixture.context,
        );
        await eventually(() => {
          expect(hooks.activePromptReview).toBe(undefined);
        });

        const delegationFailures: string[] = [];
        hooks.pauseForDelegationFailure = (reason) => {
          delegationFailures.push(reason);
        };
        hooks.finishDelegation = async () => {
          throw new Error('response boundary failed');
        };
        hooks.queueDelegationResponse({}, {});
        await eventually(() => {
          expect(delegationFailures).toContain('response boundary failed');
        });
        hooks.cleanupDelegation = async () => {
          throw new Error('failure cleanup failed');
        };
        hooks.queueDelegationFailure({}, 'original failure');
        await eventually(() => {
          expect(delegationFailures).toContain('failure cleanup failed');
        });

        hooks.finishPromptReview = async () => {
          throw new Error('review result failed');
        };
        hooks.queuePromptReviewResult({}, { status: 'dismissed' });
        await eventually(() => {
          expect(
            fixture.notifications.some(({ message }) =>
              message.includes(
                'Cannot apply built-in review: review result failed',
              ),
            ),
          ).toBe(true);
        });
        hooks.activePromptReview = {};
        hooks.pausePromptGate = () => {
          throw new Error('review pause failed');
        };
        hooks.queuePromptReviewFailure(hooks.activePromptReview, 'failed');
        await eventually(() => {
          expect(
            fixture.notifications.some(({ message }) =>
              message.includes(
                'Cannot pause failed built-in review: review pause failed',
              ),
            ),
          ).toBe(true);
        });

        hooks.handlePlannotatorResult = async () => {
          throw new Error('Plannotator boundary failed');
        };
        fixture.events.emit(PLANNOTATOR_RESULT_CHANNEL, {});

        // then
        await eventually(() => {
          expect(
            fixture.notifications.some(({ message }) =>
              message.includes(
                'Cannot apply Plannotator result: Plannotator boundary failed',
              ),
            ),
          ).toBe(true);
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('/workflow-list displays loaded workflows as a Markdown table', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-list-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeWorkflow(directory, 'Delegate | one\nstep');
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const list = fixture.commands.get('workflow-list');
        expectTruthy(list);

        await list('', fixture.context);

        expect(fixture.sentMessages).toEqual([
          {
            customType: 'workflow-list',
            content: [
              '| Workflow | Command | Description |',
              '| --- | --- | --- |',
              '| `delegate` | `/delegate` | Delegate \\| one step |',
            ].join('\n'),
            display: true,
          },
        ]);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the shortcut opens the full workflow status overlay on demand', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-status-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture, 'ctrl+shift+y');
        const start = fixture.commands.get('main-workflow');
        expectTruthy(start);

        await start('inspect the repository', fixture.context);

        expect(fixture.customRenders).toHaveLength(0);
        const shortcut = fixture.shortcuts.get('ctrl+shift+y');
        expectTruthy(shortcut);
        expect(fixture.shortcuts.has('ctrl+alt+w')).toBe(false);
        await shortcut(fixture.context as unknown as ExtensionContext);
        expect(fixture.customRenders).toHaveLength(1);
        const board = fixture.customRenders.at(-1)?.join('\n') ?? '';
        expect(board).toMatch(/✦ Workflow Status/);
        expect(board).toMatch(/\[RUNNING\]/);
        expect(board).toMatch(/main/);
        expect(board).toMatch(/execution main agent/);
        expect(board).toMatch(/Ctrl\+Shift\+Y/);
        expect(fixture.customRenders.at(-1)?.length).toBeGreaterThan(10);
        expect(fixture.customOptions.at(-1)).toMatchObject({
          overlay: true,
          overlayOptions: {
            anchor: 'center',
            width: '95%',
            maxHeight: '95%',
          },
        });
        expect(
          fixture.widgetUpdates.every(({ lines }) => lines === undefined),
        ).toBe(true);
        expect(
          fixture.statusUpdates.some(({ value }) =>
            /^[◐◓◑◒] main · step plan · working · Ctrl\+Shift\+Y$/.test(
              value ?? '',
            ),
          ),
        ).toBe(true);
        expect(fixture.commands.has('workflow-status')).toBe(false);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('clears the status board when no workflow checkpoint exists', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-empty-status-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        expect(fixture.commands.has('workflow-status')).toBe(false);
        expect(fixture.widgetUpdates.at(-1)).toEqual({
          key: 'pi-workflows-progress',
          lines: undefined,
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the harness runs an omitted-subagent step in the main agent', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-main-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        let delegated = false;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
          delegated = true;
        });

        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const completion = fixture.tools.get('workflow_complete_step');
        expectTruthy(start);
        expectTruthy(completion);
        await start('the repository', fixture.context);

        expect(delegated).toBe(false);
        expect(fixture.sentUserMessages.length).toBe(1);
        expect(fixture.sentUserMessages[0] ?? '').toMatch(
          /Main-agent declarative/,
        );
        expect(fixture.activeTools()).toEqual([
          'read',
          'workflow_complete_step',
        ]);

        const task = fixture.sentUserMessages[0] ?? '';
        await emitLifecycle(fixture, 'message_end', {
          type: 'message_end',
          message: {
            role: 'user',
            content: [{ type: 'text', text: task }],
          },
        });
        await emitLifecycle(fixture, 'turn_end', {
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Inspect with Authorization: Bearer harness-secret',
              },
              {
                type: 'toolCall',
                id: 'read-1',
                name: 'read',
                arguments: {
                  path: 'README.md',
                  password: 'harness-argument-secret',
                },
              },
            ],
          },
          toolResults: [
            {
              role: 'toolResult',
              toolCallId: 'read-1',
              toolName: 'read',
              isError: false,
              content: [{ type: 'text', text: 'README is ready' }],
            },
          ],
        });

        const tracedRun = latestRun(fixture);
        expect(isWorkflowRun(tracedRun)).toBe(true);
        if (!isWorkflowRun(tracedRun)) {
          throw new Error('Expected a valid traced workflow run');
        }
        const tracedAttempt = tracedRun.currentStepAttempts?.at(-1);
        expect(
          tracedAttempt?.kind === 'main'
            ? tracedAttempt.log?.map((line) => line.split('\n')[0])
            : undefined,
        ).toEqual(['assistant', 'tool call · read', 'tool result · read']);
        expect(JSON.stringify(tracedRun.currentStepAttempts)).not.toContain(
          'harness-secret',
        );
        expect(JSON.stringify(tracedRun.currentStepAttempts)).not.toContain(
          'harness-argument-secret',
        );

        const completionResult = await completion.execute('completion-1', {
          outcome: 'done',
          summary: 'Main-agent inspection complete',
        });
        expect((completionResult as { terminate?: boolean }).terminate).toBe(
          true,
        );
        const completionMessage = {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'completion-1',
              name: 'workflow_complete_step',
              arguments: {
                outcome: 'done',
                summary: 'Main-agent inspection complete',
              },
            },
          ],
        };
        await emitLifecycle(fixture, 'message_end', {
          type: 'message_end',
          message: completionMessage,
        });
        await emitLifecycle(fixture, 'turn_end', {
          type: 'turn_end',
          message: completionMessage,
          toolResults: [
            {
              role: 'toolResult',
              toolCallId: 'completion-1',
              toolName: 'workflow_complete_step',
              isError: false,
              content: [{ type: 'text', text: 'Captured outcome' }],
            },
          ],
        });
        await emitLifecycle(fixture, 'turn_end', {
          type: 'turn_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'unrelated queued parent turn' }],
          },
          toolResults: [],
        });
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });

        const completedRun = latestRun(fixture);
        expect(isWorkflowRun(completedRun)).toBe(true);
        if (!isWorkflowRun(completedRun)) {
          throw new Error('Expected a valid completed workflow run');
        }
        expect(completedRun.status).toBe('completed');
        const completedLog = completedRun.history[0]?.attempts?.at(-1);
        expect(completedLog?.kind).toBe('main');
        const completedLogText =
          completedLog?.kind === 'main'
            ? (completedLog.log?.join('\n') ?? '')
            : '';
        expect(completedLogText).toContain('tool call · read');
        expect(completedLogText).toContain(
          'tool call · workflow_complete_step',
        );
        expect(completedLogText).not.toContain('harness-secret');
        expect(completedLogText).not.toContain('harness-argument-secret');
        expect(completedLogText).not.toContain('unrelated queued parent turn');
        const postedSummary = fixture.sentMessages.find(
          ({ customType }) => customType === 'workflow-step-summary',
        );
        expect(postedSummary?.content).toContain(
          'Main-agent inspection complete',
        );
        expect(postedSummary?.content).toContain('Workflow `main` completed.');
        expect(postedSummary?.content).not.toContain('tool call · read');
        expect(isWorkflowRun(JSON.parse(JSON.stringify(completedRun)))).toBe(
          true,
        );
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
        expect(
          fixture.statusUpdates.some(({ value }) =>
            /^[◐◓◑◒] /.test(value ?? ''),
          ),
        ).toBe(true);
        expect(fixture.statusUpdates.at(-1)?.value).toBe(undefined);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a main-agent step can pause and resume from the same step', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-main-pause-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const pause = fixture.commands.get('workflow-pause');
        const resume = fixture.commands.get('workflow-resume');
        const completion = fixture.tools.get('workflow_complete_step');
        expectTruthy(start);
        expectTruthy(pause);
        expectTruthy(resume);
        expectTruthy(completion);

        await start('the repository', fixture.context);
        fixture.setIdle(false);
        await pause('repair the workflow', fixture.context);
        expect(latestRun(fixture).status).toBe('paused');
        expect(latestRun(fixture).currentStepId).toBe('plan');
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
        expect(fixture.abortCount()).toBe(1);
        expect(fixture.waitForIdleCount()).toBe(1);
        expect(fixture.sentMessages.at(-1)?.content).toContain(
          'repair the workflow',
        );
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        expect(latestRun(fixture).status).toBe('paused');

        await resume('', fixture.context);
        expect(fixture.sentUserMessages.length).toBe(2);
        await completion.execute('completion-after-resume', {
          outcome: 'done',
          summary: 'Completed after repair',
        });
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        expect(latestRun(fixture).status).toBe('completed');
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a main-agent step refuses resume from a different session cwd', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-main-cwd-'));
      const alternateDirectory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-main-other-cwd-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const pause = fixture.commands.get('workflow-pause');
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(start);
        expectTruthy(pause);
        expectTruthy(resume);

        await start('the repository', fixture.context);
        fixture.setIdle(false);
        await pause('switch sessions', fixture.context);
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        (fixture.context as unknown as { cwd: string }).cwd =
          alternateDirectory;

        await resume('', fixture.context);

        expect(fixture.sentUserMessages).toHaveLength(1);
        expect(latestRun(fixture).status).toBe('paused');
        expect(String(latestRun(fixture).pauseReason)).toMatch(
          /current session cwd[\s\S]*does not match captured workflow cwd/,
        );
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(alternateDirectory, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a main-agent step pauses when it settles without completion', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-main-settle-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        expectTruthy(start);
        await start('the repository', fixture.context);
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });

        expect(latestRun(fixture).status).toBe('paused');
        expect(String(latestRun(fixture).pauseReason)).toMatch(
          /without calling workflow_complete_step exactly once/,
        );
        expect(fixture.sentMessages.at(-1)?.content).toContain(
          'agent settled without calling workflow_complete_step exactly once',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the built-in prompt gate loops through feedback and approval', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-prompt-gate-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory, true);
        const fixture = createHarnessFixture(directory);
        let plannotatorRequests = 0;
        fixture.events.on(PLANNOTATOR_REQUEST_CHANNEL, () => {
          plannotatorRequests += 1;
        });
        fixture.selectResponses.push('Request changes', 'Approve');
        fixture.inputResponses.push('Add a rollback check');

        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const completion = fixture.tools.get('workflow_complete_step');
        expectTruthy(start);
        expectTruthy(completion);
        await start('the change', fixture.context);

        await completion.execute('completion-1', {
          outcome: 'submit',
          summary: 'First plan',
          artifact: '# Plan v1',
        });
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        await eventually(() => {
          expect(fixture.sentUserMessages.length).toBe(2);
        });
        expect(fixture.sentUserMessages[1] ?? '').toMatch(
          /Add a rollback check/,
        );

        await completion.execute('completion-2', {
          outcome: 'submit',
          summary: 'Revised plan',
          artifact: '# Plan v2',
        });
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(latestRun(fixture).reviewedArtifact).toBe('# Plan v2');
        expect(latestRun(fixture).gateFeedback).toBe('');
        expect(plannotatorRequests).toBe(0);
        expect(
          fixture.statusUpdates.some(({ value }) =>
            /^◆ main · step plan · awaiting review · Ctrl\+Alt\+W$/.test(
              value ?? '',
            ),
          ),
        ).toBe(true);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a dismissed built-in review stays pending and reopens on resume', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-prompt-pause-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory, true);
        const fixture = createHarnessFixture(directory);
        fixture.selectResponses.push(undefined);

        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const resume = fixture.commands.get('workflow-resume');
        const completion = fixture.tools.get('workflow_complete_step');
        expectTruthy(start);
        expectTruthy(resume);
        expectTruthy(completion);
        await start('the change', fixture.context);
        await completion.execute('completion-before-review', {
          outcome: 'submit',
          summary: 'Plan ready',
          artifact: '# Pending plan',
        });
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(
          (latestRun(fixture).pendingGate as { provider?: string }).provider,
        ).toBe('prompt');
        expect(latestRun(fixture).failedStepId).toBe(undefined);
        expect(fixture.statusUpdates.at(-1)?.value).toBe(undefined);

        fixture.selectResponses.push('Approve');
        await resume('', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(latestRun(fixture).reviewedArtifact).toBe('# Pending plan');
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the harness launches the configured agent and advances from its correlated structured result', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeWorkflow(directory, 'Delegate one step', 'scout');
        const fixture = createHarnessFixture(directory);
        let delegatedRequest: SubagentDelegationRequest | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          delegatedRequest = data as SubagentDelegationRequest;
          expect(fixture.activeTools()).toEqual([]);
          const extracted = extractChildPolicy(delegatedRequest.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Inspected in the child',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
            currentTool: 'read',
            toolCount: 2,
            tokens: 120,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        fixture.setIdle(false);
        await start('the repository', fixture.context);

        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(fixture.abortCount()).toBe(1);
        expect(fixture.waitForIdleCount()).toBe(1);
        expect(delegatedRequest?.agent).toBe('scout');
        expect(delegatedRequest?.task).toMatch(/Agent profile: scout/);
        expect(
          extractChildPolicy(delegatedRequest?.task ?? '')?.policy.agent,
        ).toBe('scout');
        expect(delegatedRequest?.context).toBe('fresh');
        expect(delegatedRequest?.skill).toBe(false);
        expect(delegatedRequest?.output).toBe(false);
        expect(delegatedRequest?.outputSchema).toMatchObject({
          type: 'object',
          required: ['outcome', 'summary'],
        });
        expect(delegatedRequest?.agentContract).toEqual({ version: 1 });
        expect(delegatedRequest?.acceptance).toBe(undefined);
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
        expect(
          fixture.statusUpdates.some(({ value }) =>
            /^[◐◓◑◒] delegate · step inspect · working · Ctrl\+Alt\+W$/.test(
              value ?? '',
            ),
          ),
        ).toBe(true);
        expect(fixture.statusUpdates.at(-1)?.value).toBe(undefined);
        expect(fixture.sentMessages.at(-1)?.content).toContain(
          'Inspected in the child',
        );
        expect(fixture.sentMessages.at(-1)?.content).toContain(
          'Workflow `delegate` completed.',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('continues an explicit retry outcome in a fresh child with its recovery handoff', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeFile(
          join(directory, 'self-heal.workflow.yaml'),
          JSON.stringify({
            version: 1,
            id: 'self-heal',
            command: 'self-heal',
            description: 'Continue a recoverable step',
            start: 'inspect',
            maxStepVisits: 3,
            steps: {
              inspect: {
                subagent: { agent: 'scout' },
                prompt: 'Inspect and recover.',
                permissions: { tools: ['read'] },
                transitions: {
                  done: '$done',
                  retry: 'inspect',
                  blocked: '$pause',
                },
              },
            },
          }),
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        const recoverySummary = [
          'Failed tool: read',
          'Arguments: {"path":"missing.md"}',
          'Tool error: file not found',
          'Observed state: no mutation occurred',
          'Next alternative: inspect README.md',
        ].join('\n');
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: requests.length === 1 ? 'retry' : 'done',
              summary:
                requests.length === 1
                  ? recoverySummary
                  : 'Recovered through the alternative',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('self-heal');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toHaveLength(2);
        expect(requests.every(({ context }) => context === 'fresh')).toBe(true);
        expect(requests[1]?.task).toContain(recoverySummary);
        expect(latestRun(fixture).history).toMatchObject([
          { stepId: 'inspect', outcome: 'retry' },
          { stepId: 'inspect', outcome: 'done' },
        ]);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('automatically recovers a replay-safe step after an ordinary tool failure', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(
          directory,
          'Delegate one step',
          { agent: 'scout', retryToolFailures: true },
          [],
        );
        const subagentRunId = 'initial-failure';
        const sessionDirectory = join(
          directory,
          'sessions',
          subagentRunId,
          'run-0',
        );
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        const missingPath = '/missing/workflow-input.md';
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          [
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'failed-read',
                    name: 'read',
                    arguments: { path: missingPath },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'failed-read',
                toolName: 'read',
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `File not found: ${missingPath}`,
                  },
                ],
              },
            }),
          ].join('\n'),
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          if (requests.length === 1) {
            await bindSessionToRequest(sessionFile, request);
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'failed',
              error: `read failed (exit 1): File not found: ${missingPath}`,
              exitCode: 1,
              runId: subagentRunId,
              childIndex: 0,
              sessionFile,
            });
            return;
          }
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Retried with an allowed command',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toHaveLength(2);
        expect(requests[1]?.task).toContain(
          '## Automatic recovery after subagent failure',
        );
        expect(requests[1]?.task).toContain(
          JSON.stringify(`Arguments: {"path":"${missingPath}"}`).slice(1, -1),
        );
        expect(requests[1]?.task).toContain(
          'Subagent exit code: 1\\nTerminal error: read failed (exit 1)',
        );
        expect(requests[1]?.task).toContain(
          `Diagnostic session: ${sessionFile}`,
        );
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith(
              'Automatic recovery for "inspect" after a subagent failure',
            ),
          ),
        ).toBe(true);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('uses two fresh recovery children for distinct replay-safe failures', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const firstRunId = 'distinct-recovery-first';
        const secondRunId = 'distinct-recovery-second';
        const firstError = 'first input path does not exist';
        const secondError = 'second manifest is stale';
        const firstSession = await writeFailureSession(
          directory,
          firstRunId,
          'read',
          { path: '/missing/first-input.md' },
          firstError,
        );
        const secondSession = await writeFailureSession(
          directory,
          secondRunId,
          'read',
          { path: '/missing/second-manifest.md' },
          secondError,
        );
        const fixture = createHarnessFixture(directory);
        const requests: Array<SubagentDelegationRequest> = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });

          if (requests.length <= 2) {
            const isFirstAttempt = requests.length === 1;
            const sessionFile = isFirstAttempt ? firstSession : secondSession;
            const runId = isFirstAttempt ? firstRunId : secondRunId;
            const error = isFirstAttempt ? firstError : secondError;
            await bindSessionToRequest(sessionFile, request);
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'failed',
              error: `read failed (exit 1): ${error}`,
              exitCode: 1,
              runId,
              childIndex: 0,
              sessionFile,
            });
            return;
          }

          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Recovered after two distinct approaches',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toHaveLength(3);
        expect(requests.every(({ context }) => context === 'fresh')).toBe(true);
        expect(requests[1]?.task).toContain(
          'automatic recovery attempt 1 of 2',
        );
        expect(requests[2]?.task).toContain(
          'automatic recovery attempt 2 of 2',
        );
        expect(requests[2]?.task).toContain(firstError);
        expect(requests[2]?.task).toContain(secondError);
        expect(
          fixture.notifications.filter(({ message }) =>
            message.startsWith(
              'Automatic recovery for "inspect" after a subagent failure',
            ),
          ),
        ).toHaveLength(2);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('stops recovery when a fresh child repeats the same semantic failure', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const failureError = 'the required input is still missing';
        const sessionFiles = await Promise.all(
          ['duplicate-recovery-first', 'duplicate-recovery-second'].map(
            (runId) =>
              writeFailureSession(
                directory,
                runId,
                'read',
                { path: '/missing/repeated-input.md' },
                failureError,
              ),
          ),
        );
        const fixture = createHarnessFixture(directory);
        const requests: Array<SubagentDelegationRequest> = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });

          const sessionFile = sessionFiles[requests.length - 1];
          if (sessionFile) {
            await bindSessionToRequest(sessionFile, request);
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'failed',
              error: `read failed (exit 1): ${failureError}`,
              exitCode: 1,
              runId:
                requests.length === 1
                  ? 'duplicate-recovery-first'
                  : 'duplicate-recovery-second',
              childIndex: 0,
              sessionFile,
            });
            return;
          }

          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Unexpected third attempt',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(2);
        expect(
          fixture.notifications.filter(({ message }) =>
            message.startsWith(
              'Automatic recovery for "inspect" after a subagent failure',
            ),
          ),
        ).toHaveLength(1);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('reinforces replay-safe terminal errors and nonzero exits in one fresh child', async () => {
      const failures = [
        {
          label: 'terminal error',
          response: {
            status: 'failed' as const,
            error: 'provider connection closed before completion',
            toolCount: 0,
          },
          expectedDiagnostic:
            'Terminal error: provider connection closed before completion',
        },
        {
          label: 'nonzero exit',
          response: {
            status: 'failed' as const,
            execution: {
              status: 'failed' as const,
              success: false,
              exitCode: 17,
            },
            toolCount: 0,
          },
          expectedDiagnostic: 'Subagent exit code: 17',
        },
        {
          label: 'structured output error',
          response: {
            status: 'structured_output_failed' as const,
            error: 'structured output did not match the required schema',
            exitCode: 1,
            toolCount: 0,
          },
          expectedDiagnostic:
            'Terminal error: structured output did not match the required schema',
        },
      ];

      for (const failure of failures) {
        // given
        const directory = await mkdtemp(
          join(tmpdir(), 'pi-workflows-reinforcement-'),
        );
        const previousDirectory = process.env.PI_WORKFLOWS_DIR;
        process.env.PI_WORKFLOWS_DIR = directory;

        try {
          await writeWorkflow(directory);
          const subagentRunId = `reinforcement-${failure.label.replaceAll(' ', '-')}`;
          const sessionDirectory = join(
            directory,
            'sessions',
            subagentRunId,
            'run-0',
          );
          const sessionFile = join(sessionDirectory, 'session.jsonl');
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(sessionFile, '');
          const fixture = createHarnessFixture(directory);
          const requests: SubagentDelegationRequest[] = [];
          fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
            const request = data as SubagentDelegationRequest;
            requests.push(request);
            fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
              version: 1,
              requestId: request.requestId,
            });
            if (requests.length === 1) {
              await bindSessionToRequest(sessionFile, request);
              fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
                version: 1,
                requestId: request.requestId,
                ...failure.response,
                runId: subagentRunId,
                childIndex: 0,
                sessionFile,
              });
              return;
            }

            const extracted = extractChildPolicy(request.task);
            expectTruthy(extracted);
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'done',
                summary: `Recovered from ${failure.label}`,
              }),
            );
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'completed',
            });
          });

          await initialize(fixture);
          const start = fixture.commands.get('delegate');
          expectTruthy(start);
          await start('the repository', fixture.context);

          // then
          await eventually(() => {
            expect(latestRun(fixture).status).toBe('completed');
          });
          expect(requests).toHaveLength(2);
          expect(requests.every(({ context }) => context === 'fresh')).toBe(
            true,
          );
          expect(requests[1]?.task).toContain(
            '## Automatic recovery after subagent failure',
          );
          expect(requests[1]?.task).toContain(failure.expectedDiagnostic);
          expect(
            fixture.notifications.filter(({ message }) =>
              message.startsWith(
                'Automatic recovery for "inspect" after a subagent failure',
              ),
            ),
          ).toHaveLength(1);
        } finally {
          if (previousDirectory === undefined)
            delete process.env.PI_WORKFLOWS_DIR;
          else process.env.PI_WORKFLOWS_DIR = previousDirectory;
          await rm(directory, { recursive: true, force: true });
        }
      }
    });

    test('pauses on a contradictory completed response instead of replaying it', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
            error: 'child reported an impossible completed error',
            exitCode: 9,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(1);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'reported terminal failure signals with completed status',
        );
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Subagent exit code: 9',
        );
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Terminal error: child reported an impossible completed error',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('pauses when the terminal tool count contradicts the replay audit', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const runId = 'mismatched-replay-audit';
        const sessionDirectory = join(directory, 'sessions', runId, 'run-0');
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(sessionFile, '');
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          await bindSessionToRequest(sessionFile, request);
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: 'provider process exited',
            exitCode: 1,
            toolCount: 1,
            runId,
            childIndex: 0,
            sessionFile,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(1);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Terminal error: provider process exited',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('does not authorize replay from a sibling delegation transcript', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const runId = 'sibling-replay-audit';
        const sessionDirectory = join(directory, 'sessions', runId, 'run-0');
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        await mkdir(sessionDirectory, { recursive: true });
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          const siblingRequestId = `${request.requestId}-sibling`;
          const siblingTask = extracted.task.replace(
            request.requestId,
            siblingRequestId,
          );
          expect(siblingTask).not.toBe(extracted.task);
          await writeFile(
            sessionFile,
            JSON.stringify({
              type: 'message',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: siblingTask,
                  },
                ],
              },
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: 'provider process exited',
            exitCode: 1,
            toolCount: 0,
            runId,
            childIndex: 0,
            agent: 'scout',
            sessionFile,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(1);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Terminal error: provider process exited',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('accepts a valid structured result when the retry recovers after a tool error', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(
          directory,
          'Delegate one replay-safe step',
          { agent: 'scout', retryToolFailures: true },
          [],
          'unrestricted',
        );
        const sessionsRoot = join(directory, 'sessions');
        const firstRunId = 'first-attempt';
        const retryRunId = 'retry-attempt';
        const firstSession = join(
          sessionsRoot,
          firstRunId,
          'run-0',
          'session.jsonl',
        );
        const retrySession = join(
          sessionsRoot,
          retryRunId,
          'run-0',
          'session.jsonl',
        );
        const failedPath = 'outside-file';
        const toolError = 'outside-file is outside repository';
        const failedTranscript = [
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'toolCall',
                  id: 'failed-read',
                  name: 'read',
                  arguments: { path: failedPath },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: 'failed-read',
              toolName: 'read',
              isError: true,
              content: [{ type: 'text', text: toolError }],
            },
          }),
        ];
        await mkdir(join(sessionsRoot, firstRunId, 'run-0'), {
          recursive: true,
        });
        await mkdir(join(sessionsRoot, retryRunId, 'run-0'), {
          recursive: true,
        });
        await writeFile(firstSession, failedTranscript.join('\n'));
        await writeFile(
          retrySession,
          [
            ...failedTranscript,
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'completed-result',
                    name: 'structured_output',
                    arguments: {
                      value: { outcome: 'done', summary: 'Recovered' },
                    },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'completed-result',
                toolName: 'structured_output',
                isError: false,
                content: [
                  { type: 'text', text: 'Structured output captured.' },
                ],
              },
            }),
          ].join('\n'),
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          if (requests.length === 1) {
            await bindSessionToRequest(firstSession, request);
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'failed',
              error: `read failed (exit 1): ${toolError}`,
              exitCode: 1,
              runId: firstRunId,
              childIndex: 0,
              sessionFile: firstSession,
            });
            return;
          }

          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Recovered',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: 'read failed (exit 1): unrelated process summary',
            exitCode: 1,
            agent: 'scout',
            execution: {
              status: 'failed',
              success: false,
              exitCode: 1,
              error: 'read failed (exit 1): unrelated process summary',
            },
            runId: retryRunId,
            childIndex: 0,
            sessionFile: retrySession,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toHaveLength(2);
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith(
              'Accepted "inspect" because the child resolved an earlier tool failure',
            ),
          ),
        ).toBe(true);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('accepts a matching result after earlier tool errors when upstream mistakes successful output for a failure', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(
          directory,
          'Delegate one non-mutating inspection',
          { agent: 'scout' },
          [],
          'unrestricted',
        );
        const runId = 'successful-output-false-positive';
        const sessionDirectory = join(directory, 'sessions', runId, 'run-0');
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        const successfulOutput = [
          "650  if (status === 'failed') return 'exit 1';",
          "651  return 'ready';",
        ].join('\n');
        const terminalError = `bash failed (exit 1): ${successfulOutput}`;
        const fixture = createHarnessFixture(directory);
        let requests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests += 1;
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await mkdir(sessionDirectory, { recursive: true });
          await writeFile(
            sessionFile,
            [
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'earlier-read-failure',
                      name: 'read',
                      arguments: { path: 'missing.md' },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'earlier-read-failure',
                  toolName: 'read',
                  isError: true,
                  content: [{ type: 'text', text: 'File not found' }],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'successful-bash',
                      name: 'bash',
                      arguments: {
                        command: "sed -n '650,700p' src/workflow-status.ts",
                      },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'successful-bash',
                  toolName: 'bash',
                  isError: false,
                  content: [{ type: 'text', text: successfulOutput }],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'completed-result',
                      name: 'structured_output',
                      arguments: {
                        value: {
                          outcome: 'done',
                          summary: 'Inspected source',
                        },
                      },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'completed-result',
                  toolName: 'structured_output',
                  isError: false,
                  content: [
                    { type: 'text', text: 'Structured output captured.' },
                  ],
                },
              }),
            ].join('\n'),
          );
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Inspected source',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: terminalError,
            exitCode: 1,
            agent: 'scout',
            execution: {
              status: 'failed',
              success: false,
              exitCode: 1,
              error: terminalError,
            },
            toolCount: 3,
            turns: 3,
            runId,
            childIndex: 0,
            sessionFile,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toBe(1);
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith(
              'Accepted "inspect" because the trusted child transcript proved the terminal tool error was a false positive',
            ),
          ),
        ).toBe(true);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('reports why a finalized child result is rejected', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(
          directory,
          'Delegate one replay-safe step',
          { agent: 'scout', retryToolFailures: true },
          [],
          'unrestricted',
        );
        const retryRunId = 'retry-missing-result';
        const retrySessionDirectory = join(
          directory,
          'sessions',
          retryRunId,
          'run-0',
        );
        const retrySession = join(retrySessionDirectory, 'session.jsonl');
        const failedPath = 'outside-file';
        const toolError = 'outside-file is outside repository';
        const firstRunId = 'initial-missing-result';
        const firstSession = await writeFailureSession(
          directory,
          firstRunId,
          'read',
          { path: failedPath },
          toolError,
        );
        await mkdir(retrySessionDirectory, { recursive: true });
        await writeFile(
          retrySession,
          [
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'failed-read',
                    name: 'read',
                    arguments: { path: failedPath },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'failed-read',
                toolName: 'read',
                isError: true,
                content: [{ type: 'text', text: toolError }],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'completed-result',
                    name: 'structured_output',
                    arguments: {
                      value: { outcome: 'done', summary: 'Recovered' },
                    },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'completed-result',
                toolName: 'structured_output',
                isError: false,
                content: [
                  { type: 'text', text: 'Structured output captured.' },
                ],
              },
            }),
          ].join('\n'),
        );
        const fixture = createHarnessFixture(directory);
        let requests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests += 1;
          if (requests === 1) {
            await bindSessionToRequest(firstSession, request);
          }
          if (requests === 2) {
            const extracted = extractChildPolicy(request.task);
            expectTruthy(extracted);
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'done',
                summary: 'Mismatched result',
              }),
            );
          }
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error:
              requests === 1
                ? `read failed (exit 1): ${toolError}`
                : 'read failed (exit 1): unrelated process summary',
            exitCode: 1,
            ...(requests === 2
              ? {
                  agent: 'scout',
                  execution: {
                    status: 'failed' as const,
                    success: false,
                    exitCode: 1,
                    error: 'read failed (exit 1): unrelated process summary',
                  },
                  runId: retryRunId,
                  childIndex: 0,
                  sessionFile: retrySession,
                }
              : {
                  runId: firstRunId,
                  childIndex: 0,
                  sessionFile: firstSession,
                }),
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toBe(2);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          `Arguments: {"path":"${failedPath}"}`,
        );
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Recovery rejected: structured_output transcript value does not match the correlated result',
        );
        const failureSummary = String(
          fixture.sentMessages.at(-1)?.content ?? '',
        );
        expect(failureSummary).toContain(
          'read failed (exit 1): unrelated process summary',
        );
        expect(failureSummary).not.toContain('Arguments:');
        expect(failureSummary).not.toContain('Recovery rejected:');
        expect(failureSummary).not.toContain('Diagnostic session:');
        const failureNotification = [...fixture.notifications]
          .reverse()
          .find(({ message }) =>
            message.startsWith('Workflow paused at'),
          )?.message;
        expect(failureNotification).toContain(
          'read failed (exit 1): unrelated process summary',
        );
        expect(failureNotification).not.toContain('Arguments:');
        expect(failureNotification).not.toContain('Recovery rejected:');
        expect(failureNotification).not.toContain('Diagnostic session:');
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('accepts finalized results only from failed execution projections', async () => {
      const rejectedTerminalStates = [
        { status: 'timed_out' as const },
        { status: 'failed' as const },
        {
          status: 'failed' as const,
          execution: {
            status: 'paused' as const,
            success: false,
            exitCode: 1,
            interrupted: true,
          },
        },
        {
          status: 'failed' as const,
          execution: {
            status: 'failed' as const,
            success: false,
            exitCode: 1,
            error: 'different execution failure',
          },
        },
        {
          status: 'failed' as const,
          error: 'process crashed',
          exitCode: 137,
          execution: {
            status: 'failed' as const,
            success: false,
            exitCode: 137,
            error: 'process crashed',
          },
        },
      ];
      for (const terminalState of rejectedTerminalStates) {
        // given
        const directory = await mkdtemp(
          join(tmpdir(), 'pi-workflows-harness-'),
        );
        const previousDirectory = process.env.PI_WORKFLOWS_DIR;
        process.env.PI_WORKFLOWS_DIR = directory;

        try {
          await writeWorkflow(
            directory,
            'Delegate one replay-safe step',
            { agent: 'scout', retryToolFailures: true },
            [],
            'unrestricted',
          );
          const retryRunId = 'rejected-retry';
          const retrySessionDirectory = join(
            directory,
            'sessions',
            retryRunId,
            'run-0',
          );
          const retrySession = join(retrySessionDirectory, 'session.jsonl');
          const firstRunId = 'initial-rejected-retry';
          const firstSession = await writeFailureSession(
            directory,
            firstRunId,
            'read',
            { path: 'missing' },
            'missing path',
          );
          await mkdir(retrySessionDirectory, { recursive: true });
          await writeFile(
            retrySession,
            [
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'failed-read',
                      name: 'read',
                      arguments: { path: 'missing' },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'failed-read',
                  toolName: 'read',
                  isError: true,
                  content: [{ type: 'text', text: 'missing path' }],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'toolCall',
                      id: 'completed-result',
                      name: 'structured_output',
                      arguments: {
                        value: { outcome: 'done', summary: 'Recovered' },
                      },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'completed-result',
                  toolName: 'structured_output',
                  isError: false,
                  content: [
                    { type: 'text', text: 'Structured output captured.' },
                  ],
                },
              }),
            ].join('\n'),
          );
          const fixture = createHarnessFixture(directory);
          const requests: SubagentDelegationRequest[] = [];
          fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
            const request = data as SubagentDelegationRequest;
            requests.push(request);
            fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
              version: 1,
              requestId: request.requestId,
            });
            if (requests.length === 1) {
              await bindSessionToRequest(firstSession, request);
              fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
                version: 1,
                requestId: request.requestId,
                status: 'failed',
                error: 'read failed (exit 1): missing path',
                exitCode: 1,
                runId: firstRunId,
                childIndex: 0,
                sessionFile: firstSession,
              });
              return;
            }

            const extracted = extractChildPolicy(request.task);
            expectTruthy(extracted);
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'done',
                summary: 'Recovered',
              }),
            );
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              error: 'read failed (exit 1): unrelated process summary',
              exitCode: 1,
              ...terminalState,
              agent: 'scout',
              runId: retryRunId,
              childIndex: 0,
              sessionFile: retrySession,
            });
          });

          await initialize(fixture);
          const start = fixture.commands.get('delegate');
          expectTruthy(start);
          await start('the repository', fixture.context);

          // then
          await eventually(() => {
            expect(latestRun(fixture).status).toBe('paused');
          });
          expect(requests).toHaveLength(2);
          expect(
            fixture.notifications.some(({ message }) =>
              message.startsWith(
                'Accepted "inspect" because the child resolved an earlier tool failure',
              ),
            ),
          ).toBe(false);
        } finally {
          if (previousDirectory === undefined)
            delete process.env.PI_WORKFLOWS_DIR;
          else process.env.PI_WORKFLOWS_DIR = previousDirectory;
          await rm(directory, { recursive: true, force: true });
        }
      }
    });

    test('pauses after a disabled-tool automatic recovery also fails', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory, 'Delegate one step', 'scout');
        const firstRunId = 'disabled-tool-attempt';
        const toolError = 'tool "grep" is not enabled by subagent "scout"';
        const firstSession = await writeFailureSession(
          directory,
          firstRunId,
          'grep',
          { pattern: 'WorkflowHarness', path: 'src' },
          toolError,
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          if (requests.length === 1) {
            await bindSessionToRequest(firstSession, request);
          }
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: `grep failed (exit 1): ${toolError}`,
            ...(requests.length === 1
              ? {
                  exitCode: 1,
                  runId: firstRunId,
                  childIndex: 0,
                  sessionFile: firstSession,
                }
              : {}),
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(2);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'grep failed (exit 1): tool "grep" is not enabled by subagent "scout"',
        );
        expect(
          fixture.notifications.filter(({ message }) =>
            message.startsWith(
              'Automatic recovery for "inspect" after a subagent failure',
            ),
          ),
        ).toHaveLength(1);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('does not replay a mutation-capable step after a Bash failure', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeFile(
          join(directory, 'mutable.workflow.yaml'),
          JSON.stringify({
            version: 1,
            id: 'mutable',
            command: 'mutable',
            description: 'Delegate a mutation-capable step',
            start: 'implement',
            steps: {
              implement: {
                subagent: { agent: 'worker', retryToolFailures: true },
                prompt: 'Implement the change.',
                permissions: {
                  tools: ['bash'],
                  bash: { mode: 'unrestricted' },
                },
                requires: { tools: ['bash'] },
                transitions: { done: '$done', blocked: '$pause' },
              },
            },
          }),
        );
        const subagentRunId = 'mutable-attempt';
        const sessionDirectory = join(
          directory,
          'sessions',
          subagentRunId,
          'run-0',
        );
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          [
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'verification-bash',
                    name: 'bash',
                    arguments: { command: 'package-tool test' },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'verification-bash',
                toolName: 'bash',
                isError: true,
                content: [
                  { type: 'text', text: 'verification command failed' },
                ],
              },
            }),
          ].join('\n'),
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: 'bash failed (exit 1): verification command failed',
            exitCode: 1,
            runId: subagentRunId,
            childIndex: 0,
            sessionFile,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('mutable');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(requests).toHaveLength(1);
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith('Automatic recovery for "implement"'),
          ),
        ).toBe(false);
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Command: package-tool test',
        );
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'Subagent exit code: 1',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('accepts a mutation-capable child result finalized after an earlier tool failure', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeFile(
          join(directory, 'mutable.workflow.yaml'),
          JSON.stringify({
            version: 1,
            id: 'mutable',
            command: 'mutable',
            description: 'Delegate a mutation-capable step',
            start: 'implement',
            steps: {
              implement: {
                subagent: { agent: 'worker' },
                prompt: 'Implement the change.',
                permissions: {
                  tools: ['bash', 'edit'],
                  bash: { mode: 'unrestricted' },
                },
                requires: { tools: ['bash'] },
                transitions: { done: '$done', blocked: '$pause' },
              },
            },
          }),
        );
        const subagentRunId = 'mutable-finalized-attempt';
        const sessionDirectory = join(
          directory,
          'sessions',
          subagentRunId,
          'run-0',
        );
        const sessionFile = join(sessionDirectory, 'session.jsonl');
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          sessionFile,
          [
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'missing-directory',
                    name: 'ls',
                    arguments: { path: '/missing/workflow-step' },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'missing-directory',
                toolName: 'ls',
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'Path not found: /missing/workflow-step',
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'completed-result',
                    name: 'structured_output',
                    arguments: {
                      value: {
                        outcome: 'done',
                        summary: '  Finished safely  ',
                      },
                    },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'toolResult',
                toolCallId: 'completed-result',
                toolName: 'structured_output',
                isError: false,
                content: [
                  { type: 'text', text: 'Structured output captured.' },
                ],
              },
            }),
            JSON.stringify({
              type: 'custom_message',
              customType: 'subagent_runtime_state',
              content: 'Completion recorded.',
            }),
            JSON.stringify({
              type: 'message',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: '',
                    textSignature: '{"v":1,"phase":"final_answer"}',
                  },
                ],
                stopReason: 'stop',
              },
            }),
          ].join('\n'),
        );
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Finished safely',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'failed',
            error: 'ls failed (exit 1): unrelated process summary',
            exitCode: 1,
            execution: {
              status: 'failed',
              success: false,
              exitCode: 1,
              error: 'ls failed (exit 1): unrelated process summary',
            },
            agent: 'worker',
            runId: subagentRunId,
            childIndex: 0,
            sessionFile,
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('mutable');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(requests).toHaveLength(1);
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith('Automatic recovery for "implement"'),
          ),
        ).toBe(false);
        expect(
          fixture.notifications.some(({ message }) =>
            message.startsWith(
              'Accepted "implement" because the child resolved an earlier tool failure',
            ),
          ),
        ).toBe(true);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('accepts only a readable clean completed transcript and blocks later watchdog warnings', async () => {
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      const scenarios: ReadonlyArray<{
        readonly name: string;
        readonly warning?: string;
        readonly omitSession?: boolean;
        readonly expectedStatus: 'completed' | 'paused';
        readonly expectedReason?: RegExp;
      }> = [
        {
          name: 'clean',
          expectedStatus: 'completed',
        },
        {
          name: 'watchdog',
          warning: 'Unexpected files changed after structured completion.',
          expectedStatus: 'paused',
          expectedReason: /unresolved post-completion watchdog warning/,
        },
        {
          name: 'unreadable',
          omitSession: true,
          expectedStatus: 'paused',
          expectedReason: /without a verifiable terminal transcript/,
        },
      ];

      try {
        for (const scenario of scenarios) {
          const directory = await mkdtemp(
            join(tmpdir(), `pi-workflows-completed-${scenario.name}-`),
          );
          process.env.PI_WORKFLOWS_DIR = directory;
          try {
            await writeWorkflow(directory);
            const fixture = createHarnessFixture(directory);
            const requests: SubagentDelegationRequest[] = [];
            fixture.events.on(
              SUBAGENT_DELEGATION_REQUEST_EVENT,
              async (data) => {
                const request = data as SubagentDelegationRequest;
                requests.push(request);
                const extracted = extractChildPolicy(request.task);
                expectTruthy(extracted);
                await writeFile(
                  extracted.policy.resultPath,
                  JSON.stringify({
                    version: 1,
                    policyDigest: extracted.policy.policyDigest,
                    outcome: 'done',
                    summary: 'Completed with correlated transcript evidence',
                  }),
                );
                const childRunId = `child-${scenario.name}`;
                const sessionFile = scenario.omitSession
                  ? join(
                      directory,
                      'sessions',
                      childRunId,
                      'run-0',
                      'session.jsonl',
                    )
                  : await writeCompletedSession(
                      directory,
                      childRunId,
                      request,
                      scenario.warning,
                    );
                fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
                  version: 1,
                  requestId: request.requestId,
                });
                fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
                  version: 1,
                  requestId: request.requestId,
                  status: 'completed',
                  agent: request.agent,
                  runId: childRunId,
                  childIndex: 0,
                  sessionFile,
                });
              },
            );

            await initialize(fixture, undefined, {
              auditCompletedDelegationTranscript,
            });
            const start = fixture.commands.get('delegate');
            expectTruthy(start);
            await start('the repository', fixture.context);
            await eventually(() => {
              expect(latestRun(fixture).status).toBe(scenario.expectedStatus);
            });

            expect(requests).toHaveLength(1);
            if (scenario.expectedStatus === 'completed') {
              expect(
                (latestRun(fixture).history as ReadonlyArray<unknown>).length,
              ).toBe(1);
            } else {
              expect(latestRun(fixture).history).toEqual([]);
              expectTruthy(scenario.expectedReason);
              expect(String(latestRun(fixture).pauseReason)).toMatch(
                scenario.expectedReason,
              );
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
      }
    });

    test('a completed delegation without a correlated child result pauses with an actionable error', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
      try {
        await writeWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
          const request = data as SubagentDelegationRequest;
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        expectTruthy(start);
        await start('the repository', fixture.context);

        // then
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });
        expect(String(latestRun(fixture).pauseReason)).toMatch(
          /without producing the required correlated structured_output result/,
        );
        expect(String(latestRun(fixture).pauseReason)).not.toMatch(/ENOENT/);
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
        expect(fixture.statusUpdates.at(-1)?.value).toBe(undefined);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('treats user-defined artifact content as opaque before review', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeGatedWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        const artifact =
          'User-defined review document\n\nNo engine-owned format is required.';
        let gateRequests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'submit',
              summary: 'Plan ready for human review',
              artifact,
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });
        fixture.events.on(PLANNOTATOR_REQUEST_CHANNEL, (data) => {
          gateRequests += 1;
          const request = data as {
            action: string;
            payload: { planContent?: string };
            respond: (response: unknown) => void;
          };
          expect(request.payload.planContent).toBe(artifact);
          request.respond({
            status: 'handled',
            result: {
              status: 'pending',
              reviewId: 'review-opaque-artifact',
            },
          });
        });

        await initialize(fixture);
        const start = fixture.commands.get('gated');
        expectTruthy(start);
        await start('the change', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('awaiting-gate');
        });

        expect(requests).toHaveLength(1);
        expect(gateRequests).toBe(1);
        expect(latestRun(fixture).history).toEqual([]);
        expect(
          (latestRun(fixture).pendingGate as { artifact?: string } | undefined)
            ?.artifact,
        ).toBe(artifact);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a delegated child cannot return a gate resolution outcome', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeGatedWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        let gateRequests = 0;
        let delegatedPolicy: ChildStepPolicy | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          delegatedPolicy = extracted.policy;
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'approved',
              summary: 'Bypass the review gate',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });
        fixture.events.on(PLANNOTATOR_REQUEST_CHANNEL, () => {
          gateRequests += 1;
        });

        await initialize(fixture);
        const start = fixture.commands.get('gated');
        expectTruthy(start);
        await start('the change', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });

        expect(delegatedPolicy?.outcomes).toEqual(['blocked', 'submit']);
        expect(delegatedPolicy?.pauseOutcomes).toEqual(['blocked']);
        expect(gateRequests).toBe(0);
        expect(latestRun(fixture).currentStepId).toBe('plan');
        expect(latestRun(fixture).pendingGate).toBe(undefined);
        expect(latestRun(fixture).history).toEqual([]);
        expect(String(latestRun(fixture).pauseReason)).toMatch(
          /invalid outcome "approved"/,
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('pause cancels the active child, ignores its late response, and resumes the same step', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        let firstResultWritten: Promise<void> | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          const writeResult = writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: `Child attempt ${requests.length}`,
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          if (requests.length === 1) {
            firstResultWritten = writeResult;
            return;
          }
          void writeResult.then(() => {
            fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
              version: 1,
              requestId: request.requestId,
              status: 'completed',
            });
          });
        });

        const cancellations: string[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
          cancellations.push((data as { requestId: string }).requestId);
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        const pause = fixture.commands.get('workflow-pause');
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(start);
        expectTruthy(pause);
        expectTruthy(resume);
        await start('the repository', fixture.context);
        expectTruthy(firstResultWritten);
        await firstResultWritten;

        const pausing = pause('repair workflow definition', fixture.context);
        await eventually(() => {
          expect(cancellations).toEqual([requests[0]!.requestId]);
          expect(requests.length).toBe(1);
        });
        fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId: requests[0]?.requestId,
          status: 'cancelled',
        });
        await pausing;
        expect(latestRun(fixture).status).toBe('paused');
        expect(latestRun(fixture).currentStepId).toBe('inspect');
        expect(cancellations).toEqual([requests[0]!.requestId]);
        expect(fixture.activeTools()).toEqual(['read', 'bash']);

        fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId: requests[0]?.requestId,
          status: 'completed',
        });
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
        });

        await resume('', fixture.context);
        await eventually(() => {
          expect(requests.length).toBe(2);
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(extractChildPolicy(requests[1]?.task ?? '')?.policy.stepId).toBe(
          'inspect',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a local delegation timeout keeps main tools and resume blocked until terminal response', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const requests: SubagentDelegationRequest[] = [];
        const cancellations: string[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          if (requests.length === 1) return;

          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Second child completed',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });
        fixture.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
          cancellations.push((data as { requestId: string }).requestId);
        });

        await initialize(fixture);
        const start = fixture.commands.get('delegate');
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(start);
        expectTruthy(resume);
        await start('the repository', fixture.context);
        expect(requests.length).toBe(1);
        expect(fixture.activeTools()).toEqual([]);

        await new Promise((resolve) => setTimeout(resolve, 3_100));
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('paused');
          expect(cancellations).toEqual([requests[0]!.requestId]);
        });
        expect(fixture.activeTools()).toEqual([]);

        await resume('', fixture.context);
        expect(requests.length).toBe(1);
        expect(fixture.activeTools()).toEqual([]);

        fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId: requests[0]?.requestId,
          status: 'cancelled',
        });
        await eventually(() => {
          expect(fixture.activeTools()).toEqual(['read', 'bash']);
        });

        await resume('', fixture.context);
        await eventually(() => {
          expect(requests.length).toBe(2);
          expect(latestRun(fixture).status).toBe('completed');
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('resume reuses the captured cwd from a valid checkpoint', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const runDirectory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-run-cwd-'),
      );
      const canonicalRunDirectory = await realpath(runDirectory);
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      try {
        await writeWorkflow(directory);
        const catalog = await loadCatalog({
          cwd: directory,
          projectTrusted: true,
          userDirectory: directory,
        });
        const workflow = catalog.workflows.get('delegate');
        expectTruthy(workflow);
        const paused = pauseRun(
          createRun(
            workflow,
            'request',
            ['read', 'bash'],
            'opaque-run',
            1,
            canonicalRunDirectory,
          ),
          'restored',
          2,
        );
        const fixture = createHarnessFixture(canonicalRunDirectory, [
          {
            type: 'custom',
            customType: 'pi-workflows-state-v1',
            data: paused,
          },
        ]);
        let delegatedRequest: SubagentDelegationRequest | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          delegatedRequest = data as SubagentDelegationRequest;
          const extracted = extractChildPolicy(delegatedRequest.task);
          expectTruthy(extracted);
          expect(extracted.policy).not.toHaveProperty('repositoryCwd');
          expect(extracted.policy).not.toHaveProperty('approvedBashCommands');
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Completed in the captured directory',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: delegatedRequest.requestId,
            status: 'completed',
          });
        });

        await initialize(fixture);
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(resume);
        await resume('', fixture.context);
        await eventually(() => {
          expect(delegatedRequest?.cwd).toBe(canonicalRunDirectory);
          expect(latestRun(fixture).status).toBe('completed');
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(runDirectory, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('Plannotator results are serialized behind pause and retained for resume', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeGatedWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        let childRequests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          childRequests += 1;
          const request = data as SubagentDelegationRequest;
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'submit',
              summary: 'Plan ready',
              artifact: '# Plan\n\nImplement carefully.',
            }),
          );
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'completed',
          });
        });
        fixture.events.on(PLANNOTATOR_REQUEST_CHANNEL, (data) => {
          const request = data as {
            action: string;
            respond: (response: unknown) => void;
          };
          if (request.action === 'plan-review') {
            request.respond({
              status: 'handled',
              result: { status: 'pending', reviewId: 'review-serialized' },
            });
          }
        });

        await initialize(fixture);
        const start = fixture.commands.get('gated');
        const pause = fixture.commands.get('workflow-pause');
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(start);
        expectTruthy(pause);
        expectTruthy(resume);
        await start('the change', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('awaiting-gate');
          expect(
            (latestRun(fixture).pendingGate as { reviewId?: string }).reviewId,
          ).toBe('review-serialized');
        });

        const pausing = pause('inspect the review', fixture.context);
        fixture.events.emit(PLANNOTATOR_RESULT_CHANNEL, {
          reviewId: 'review-serialized',
          approved: true,
          feedback: 'Approved while pausing',
        });
        await pausing;
        await eventually(() => {
          const run = latestRun(fixture);
          expect(run.status).toBe('paused');
          const pendingGate = run.pendingGate as {
            resolution?: { approved?: boolean };
          };
          expect(pendingGate.resolution?.approved).toBe(true);
        });
        expect(childRequests).toBe(1);

        await resume('', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
        });
        expect(latestRun(fixture).stepHandoff).toBe('Plan ready');
        expect(latestRun(fixture).reviewedArtifact).toBe(
          '# Plan\n\nImplement carefully.',
        );
        expect(latestRun(fixture).lastSummary).toBe('Plan ready');
        const history = latestRun(fixture).history as Array<{
          summary: string;
          artifact?: string;
        }>;
        expect(history.at(-1)?.summary).toBe('Plan ready');
        expect(history.at(-1)?.artifact).toBe('# Plan\n\nImplement carefully.');
        expect(childRequests).toBe(1);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
