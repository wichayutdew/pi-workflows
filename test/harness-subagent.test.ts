import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { WorkflowHarness } from '../src/harness.ts';
import { loadCatalog } from '../src/config/load.ts';
import { createRun } from '../src/engine/state.ts';
import { pauseRun } from '../src/engine/transitions.ts';
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_RESULT_CHANNEL,
} from '../src/integrations/plannotator.ts';
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
        lines: string[] | undefined,
        options?: { placement?: string },
      ) {
        widgetUpdates.push({
          key,
          lines: lines ? [...lines] : undefined,
          ...(options ? { options } : {}),
        });
      },
      select: async () => selectResponses.shift(),
      input: async () => inputResponses.shift(),
      custom: async (factory: CustomFactory) =>
        new Promise<unknown>((resolve, reject) => {
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
      tools,
      checkpoints,
      sentMessages,
      sentUserMessages,
      notifications,
      customRenders,
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
              tools: ['read'],
              ...(skills.length > 0 ? { skills } : {}),
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

  async function writeGatedPublishWorkflow(directory: string): Promise<void> {
    await writeFile(
      join(directory, 'gated-publish.workflow.yaml'),
      JSON.stringify({
        version: 1,
        id: 'gated-publish',
        command: 'gated-publish',
        description: 'Approve and execute one exact remote action',
        start: 'plan',
        steps: {
          plan: {
            subagent: {},
            prompt: 'Prepare exact actions for {{workflow.input}}.',
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
              approved: 'verify',
              'changes-requested': 'plan',
              blocked: '$pause',
            },
          },
          verify: {
            subagent: {},
            prompt: 'Narrow reviewed actions from {{last.summary}}.',
            permissions: {
              tools: ['read'],
            },
            transitions: {
              ready: 'publish',
              blocked: '$pause',
            },
          },
          publish: {
            subagent: {},
            prompt: 'Execute only {{last.summary}}.',
            permissions: {
              tools: ['bash'],
              bash: {
                mode: 'allow-list',
                approvedSources: ['remote-actions'],
              },
            },
            transitions: {
              published: '$done',
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

  async function initialize(fixture: HarnessFixture): Promise<WorkflowHarness> {
    const harness = new WorkflowHarness(fixture.pi);
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

    test('/workflow-status opens a live TUI and keeps a text fallback', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-status-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeMainWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        await initialize(fixture);
        const start = fixture.commands.get('main-workflow');
        const status = fixture.commands.get('workflow-status');
        expectTruthy(start);
        expectTruthy(status);

        await start('inspect the repository', fixture.context);
        await status('', fixture.context);

        expect(fixture.customRenders.length).toBe(1);
        const board = fixture.customRenders[0]?.join('\n') ?? '';
        expect(board).toMatch(/✦ Workflow Status/);
        expect(board).toMatch(/\[RUNNING\]/);
        expect(board).toMatch(/main/);
        expect(board).toMatch(/execution main agent/);
        expect(fixture.repaintRequests).toEqual([true]);

        fixture.setMode('json');
        await status('', fixture.context);
        const fallback = fixture.notifications.at(-1);
        expectTruthy(fallback);
        expect(fallback.type).toBe('info');
        expect(fallback.message).toMatch(/Workflow: main/);
        expect(fallback.message).toMatch(/Status: running/);
        expect(fallback.message).toMatch(/Execution: main agent/);
        expect(fixture.customRenders.length).toBe(1);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('/workflow-status keeps the no-checkpoint notification', async () => {
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
        const status = fixture.commands.get('workflow-status');
        expectTruthy(status);

        await status('', fixture.context);

        expect(fixture.customRenders).toEqual([]);
        expect(fixture.notifications.at(-1)).toEqual({
          message: 'No workflow checkpoint in this session',
          type: 'info',
        });
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

        const completionResult = await completion.execute('completion-1', {
          outcome: 'done',
          summary: 'Main-agent inspection complete',
        });
        expect((completionResult as { terminate?: boolean }).terminate).toBe(
          true,
        );
        await emitLifecycle(fixture, 'agent_settled', {
          type: 'agent_settled',
        });

        expect(latestRun(fixture).status).toBe('completed');
        expect(fixture.activeTools()).toEqual(['read', 'bash']);
        expect(
          fixture.statusUpdates.some(({ value }) => value?.startsWith('↻ ')),
        ).toBe(true);
        expect(
          fixture.statusUpdates.some(({ value }) => value?.startsWith('✓ ')),
        ).toBe(true);
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
        expect(
          fixture.statusUpdates.some(({ value }) => value?.startsWith('◆ ')),
        ).toBe(true);

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
          fixture.widgetUpdates.some(({ lines }) =>
            lines?.includes('↻ inspect'),
          ),
        ).toBe(true);
        expect(fixture.widgetUpdates.at(-1)).toEqual({
          key: 'pi-workflows-progress',
          lines: ['✓ inspect'],
          options: { placement: 'belowEditor' },
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
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
        expect(
          fixture.statusUpdates.some(({ value }) => value?.startsWith('✕ ')),
        ).toBe(true);
        expect(fixture.widgetUpdates.at(-1)).toEqual({
          key: 'pi-workflows-progress',
          lines: ['✕ inspect'],
          options: { placement: 'belowEditor' },
        });
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

    test('resume bootstraps a missing reviewed target from its reviewed source cwd', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const sourceDirectory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-reviewed-source-'),
      );
      const repositoryCwd = join(directory, 'not-created-target');
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
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
          createRun(workflow, 'request', ['read', 'bash'], 'bootstrap-run', 1),
          'restored',
          2,
        );
        const fixture = createHarnessFixture(directory, [
          {
            type: 'custom',
            customType: 'pi-workflows-state-v1',
            data: {
              ...paused,
              reviewedArtifact: JSON.stringify({
                repositories: [
                  { cwd: repositoryCwd, sourceCwd: sourceDirectory },
                ],
              }),
            },
          },
        ]);
        let delegatedRequest: SubagentDelegationRequest | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          delegatedRequest = data as SubagentDelegationRequest;
          const extracted = extractChildPolicy(delegatedRequest.task);
          expectTruthy(extracted);
          expect(extracted.policy.repositoryCwd).toBe(repositoryCwd);
          expect(extracted.policy.bootstrapCwd).toBe(sourceDirectory);
          await writeFile(
            extracted.policy.resultPath,
            JSON.stringify({
              version: 1,
              policyDigest: extracted.policy.policyDigest,
              outcome: 'done',
              summary: 'Bootstrapped the reviewed target',
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
          expect(delegatedRequest?.cwd).toBe(sourceDirectory);
          expect(latestRun(fixture).status).toBe('completed');
        });
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(sourceDirectory, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('resume pauses an invalid reviewed repository contract before delegation', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const secondDirectory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-reviewed-target-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;

      // when
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
            'invalid-cwd-run',
            1,
          ),
          'restored',
          2,
        );
        const fixture = createHarnessFixture(directory, [
          {
            type: 'custom',
            customType: 'pi-workflows-state-v1',
            data: {
              ...paused,
              reviewedArtifact: JSON.stringify({
                repositories: [{ cwd: directory }, { cwd: secondDirectory }],
              }),
            },
          },
        ]);
        let delegationRequests = 0;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
          delegationRequests += 1;
        });

        await initialize(fixture);
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(resume);
        await resume('', fixture.context);

        expect(delegationRequests).toBe(0);
        expect(latestRun(fixture).status).toBe('paused');
        expect(String(latestRun(fixture).pauseReason)).toContain(
          'expected exactly one repository cwd',
        );
        expect(fixture.notifications.at(-1)?.message).toContain(
          'expected exactly one repository cwd',
        );
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(secondDirectory, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('legacy checkpoints do not derive approved Bash commands from lastSummary', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      try {
        await writeFile(
          join(directory, 'legacy.workflow.yaml'),
          JSON.stringify({
            version: 1,
            id: 'legacy',
            command: 'legacy',
            description: 'Legacy checkpoint',
            start: 'implement',
            steps: {
              implement: {
                subagent: {},
                prompt: 'Implement {{last.summary}}.',
                permissions: {
                  tools: ['read', 'bash'],
                  bash: {
                    mode: 'allow-list',
                    approvedSources: ['verification-worker'],
                  },
                },
                transitions: {
                  done: '$done',
                  blocked: '$pause',
                },
              },
            },
          }),
        );
        const catalog = await loadCatalog({
          cwd: directory,
          projectTrusted: true,
          userDirectory: directory,
        });
        const workflow = catalog.workflows.get('legacy');
        expectTruthy(workflow);
        const paused = pauseRun(
          createRun(workflow, 'request', ['read', 'bash'], 'legacy-run', 1),
          'restored',
          2,
        );
        const legacyRun = {
          ...paused,
          lastSummary:
            '```json\n{"repositories":[{"worker":[{"command":"npm test"}]}]}\n```',
        };
        delete legacyRun.stepHandoff;
        delete legacyRun.reviewedArtifact;
        const fixture = createHarnessFixture(directory, [
          {
            type: 'custom',
            customType: 'pi-workflows-state-v1',
            data: legacyRun,
          },
        ]);
        let delegatedPolicy: ChildStepPolicy | undefined;
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
          const request = data as SubagentDelegationRequest;
          delegatedPolicy = extractChildPolicy(request.task)?.policy;
          fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
            version: 1,
            requestId: request.requestId,
          });
          fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            version: 1,
            requestId: request.requestId,
            status: 'cancelled',
          });
        });

        await initialize(fixture);
        const resume = fixture.commands.get('workflow-resume');
        expectTruthy(resume);
        await resume('', fixture.context);
        await eventually(() => {
          expectTruthy(delegatedPolicy);
        });
        expect(delegatedPolicy?.approvedBashCommands).toBe(undefined);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('a reviewed gate artifact grants only commands retained by the latest handoff', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      // when
      process.env.PI_WORKFLOWS_DIR = directory;
      // then
      const approvedDirectory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-approved-cwd-'),
      );
      try {
        await writeGatedPublishWorkflow(directory);
        const fixture = createHarnessFixture(directory);
        const approvedCommand =
          'glab api projects/1/merge_requests/2/notes -f body=approved';
        const removedCommand =
          'glab api projects/1/merge_requests/2/notes -f body=removed';
        const unreviewedCommand =
          'glab api projects/1/merge_requests/2/notes -f body=unreviewed';
        const policies: ChildStepPolicy[] = [];
        const requests: SubagentDelegationRequest[] = [];
        fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
          const request = data as SubagentDelegationRequest;
          requests.push(request);
          const extracted = extractChildPolicy(request.task);
          expectTruthy(extracted);
          policies.push(extracted.policy);
          if (extracted.policy.stepId === 'plan') {
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'submit',
                summary: [
                  'Unreviewed handoff',
                  '```json',
                  JSON.stringify({
                    repositories: [{ cwd: approvedDirectory }],
                    actions: [
                      {
                        toolName: 'bash',
                        input: { command: unreviewedCommand },
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
                artifact: [
                  '# Reviewed actions',
                  '```json',
                  JSON.stringify({
                    repositories: [{ cwd: approvedDirectory }],
                    actions: [
                      {
                        toolName: 'bash',
                        input: { command: approvedCommand },
                      },
                      {
                        toolName: 'bash',
                        input: { command: removedCommand },
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
              }),
            );
          } else if (extracted.policy.stepId === 'verify') {
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'ready',
                summary: [
                  '# Narrowed actions',
                  '```json',
                  JSON.stringify({
                    actions: [
                      {
                        toolName: 'bash',
                        input: { command: approvedCommand },
                      },
                      {
                        toolName: 'bash',
                        input: { command: unreviewedCommand },
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
              }),
            );
          } else {
            await writeFile(
              extracted.policy.resultPath,
              JSON.stringify({
                version: 1,
                policyDigest: extracted.policy.policyDigest,
                outcome: 'published',
                summary: 'Exact reviewed action completed',
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
              result: { status: 'pending', reviewId: 'review-exact-command' },
            });
          }
        });

        await initialize(fixture);
        const start = fixture.commands.get('gated-publish');
        expectTruthy(start);
        await start('the merge request', fixture.context);
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('awaiting-gate');
        });
        fixture.events.emit(PLANNOTATOR_RESULT_CHANNEL, {
          reviewId: 'review-exact-command',
          approved: true,
          feedback: 'Approved',
        });
        await eventually(() => {
          expect(latestRun(fixture).status).toBe('completed');
          expect(policies.length).toBe(3);
        });
        expect(policies[2]?.approvedBashCommands).toEqual([approvedCommand]);
        expect(
          policies[2]?.approvedBashCommands?.includes(removedCommand),
        ).toBe(false);
        expect(
          policies[2]?.approvedBashCommands?.includes(unreviewedCommand),
        ).toBe(false);
        expect(requests[1]?.context).toBe('fresh');
        expect(requests[0]?.cwd).toBe(directory);
        expect(requests[1]?.cwd).toBe(approvedDirectory);
        expect(requests[1]?.task.match(/# Reviewed actions/g)).toHaveLength(1);
        expect(requests[1]?.task).not.toContain('Unreviewed handoff');
        expect(requests[2]?.context).toBe('fresh');
        expect(requests[2]?.cwd).toBe(approvedDirectory);
        expect(requests[2]?.task.match(/# Narrowed actions/g)).toHaveLength(1);
        expect(requests[2]?.task).not.toContain('# Reviewed actions');
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(approvedDirectory, { recursive: true, force: true });
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
        expect(latestRun(fixture).stepHandoff).toBe(
          '# Plan\n\nImplement carefully.',
        );
        expect(latestRun(fixture).reviewedArtifact).toBe(
          '# Plan\n\nImplement carefully.',
        );
        expect(latestRun(fixture).lastSummary).toBe(
          '# Plan\n\nImplement carefully.',
        );
        const history = latestRun(fixture).history as Array<{
          summary: string;
        }>;
        expect(history.at(-1)?.summary).toBe('# Plan\n\nImplement carefully.');
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
