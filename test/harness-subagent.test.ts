import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  type ChildStepPolicy,
  type SubagentDelegationRequest,
} from '../src/integrations/subagents/protocol.ts';

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
    setStatus() {},
    select: async () => selectResponses.shift(),
    input: async () => inputResponses.shift(),
    custom: async (factory: CustomFactory) =>
      new Promise<unknown>((resolve, reject) => {
        const tui = {
          requestRender(force?: boolean) {
            repaintRequests.push(force);
          },
        };
        Promise.resolve(factory(tui, theme, {}, resolve)).then((component) => {
          customRenders.push(component.render(120));
          component.handleInput?.('q');
        }, reject);
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
        sourceInfo: { source: 'extension', path: '/pi-workflows/src/index.ts' },
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
          subagent: {},
          prompt: 'Inspect {{workflow.input}}.',
          permissions: {
            tools: ['read'],
          },
          requires: {
            tools: ['read'],
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
            approved: 'publish',
            'changes-requested': 'plan',
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

async function initialize(fixture: HarnessFixture): Promise<void> {
  new WorkflowHarness(fixture.pi);
  await emitLifecycle(fixture, 'session_start', { type: 'session_start' });
}

async function emitLifecycle(
  fixture: HarnessFixture,
  event: string,
  payload: Record<string, unknown>,
): Promise<unknown[]> {
  const handlers = fixture.lifecycle.get(event) ?? [];
  assert.ok(handlers.length > 0);
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
  assert.ok(checkpoint);
  return checkpoint.data as Record<string, unknown>;
}

test('/workflow-list displays loaded workflows as a Markdown table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-list-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory, 'Delegate | one\nstep');
    const fixture = createHarnessFixture(directory);
    await initialize(fixture);
    const list = fixture.commands.get('workflow-list');
    assert.ok(list);

    await list('', fixture.context);

    assert.deepEqual(fixture.sentMessages, [
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
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('/workflow-status opens a live TUI and keeps a text fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-status-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeMainWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    await initialize(fixture);
    const start = fixture.commands.get('main-workflow');
    const status = fixture.commands.get('workflow-status');
    assert.ok(start);
    assert.ok(status);

    await start('inspect the repository', fixture.context);
    await status('', fixture.context);

    assert.equal(fixture.customRenders.length, 1);
    const board = fixture.customRenders[0]?.join('\n') ?? '';
    assert.match(board, /✦ Workflow Status/);
    assert.match(board, /\[RUNNING\]/);
    assert.match(board, /main/);
    assert.match(board, /execution main agent/);
    assert.deepEqual(fixture.repaintRequests, [true]);

    fixture.setMode('json');
    await status('', fixture.context);
    const fallback = fixture.notifications.at(-1);
    assert.ok(fallback);
    assert.equal(fallback.type, 'info');
    assert.match(fallback.message, /Workflow: main/);
    assert.match(fallback.message, /Status: running/);
    assert.match(fallback.message, /Execution: main agent/);
    assert.equal(fixture.customRenders.length, 1);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('/workflow-status keeps the no-checkpoint notification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-empty-status-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    const fixture = createHarnessFixture(directory);
    await initialize(fixture);
    const status = fixture.commands.get('workflow-status');
    assert.ok(status);

    await status('', fixture.context);

    assert.deepEqual(fixture.customRenders, []);
    assert.deepEqual(fixture.notifications.at(-1), {
      message: 'No workflow checkpoint in this session',
      type: 'info',
    });
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the harness runs an omitted-subagent step in the main agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-main-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
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
    assert.ok(start);
    assert.ok(completion);
    await start('the repository', fixture.context);

    assert.equal(delegated, false);
    assert.equal(fixture.sentUserMessages.length, 1);
    assert.match(fixture.sentUserMessages[0] ?? '', /Main-agent declarative/);
    assert.deepEqual(fixture.activeTools(), ['read', 'workflow_complete_step']);

    const completionResult = await completion.execute('completion-1', {
      outcome: 'done',
      summary: 'Main-agent inspection complete',
    });
    assert.equal((completionResult as { terminate?: boolean }).terminate, true);
    await emitLifecycle(fixture, 'agent_settled', {
      type: 'agent_settled',
    });

    assert.equal(latestRun(fixture).status, 'completed');
    assert.deepEqual(fixture.activeTools(), ['read', 'bash']);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a main-agent step can pause and resume from the same step', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-main-pause-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeMainWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    await initialize(fixture);
    const start = fixture.commands.get('main-workflow');
    const pause = fixture.commands.get('workflow-pause');
    const resume = fixture.commands.get('workflow-resume');
    const completion = fixture.tools.get('workflow_complete_step');
    assert.ok(start);
    assert.ok(pause);
    assert.ok(resume);
    assert.ok(completion);

    await start('the repository', fixture.context);
    fixture.setIdle(false);
    await pause('repair the workflow', fixture.context);
    assert.equal(latestRun(fixture).status, 'paused');
    assert.equal(latestRun(fixture).currentStepId, 'plan');
    assert.deepEqual(fixture.activeTools(), ['read', 'bash']);
    assert.equal(fixture.abortCount(), 1);
    assert.equal(fixture.waitForIdleCount(), 1);
    await emitLifecycle(fixture, 'agent_settled', {
      type: 'agent_settled',
    });
    assert.equal(latestRun(fixture).status, 'paused');

    await resume('', fixture.context);
    assert.equal(fixture.sentUserMessages.length, 2);
    await completion.execute('completion-after-resume', {
      outcome: 'done',
      summary: 'Completed after repair',
    });
    await emitLifecycle(fixture, 'agent_settled', {
      type: 'agent_settled',
    });
    assert.equal(latestRun(fixture).status, 'completed');
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a main-agent step pauses when it settles without completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-main-settle-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeMainWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    await initialize(fixture);
    const start = fixture.commands.get('main-workflow');
    assert.ok(start);
    await start('the repository', fixture.context);
    await emitLifecycle(fixture, 'agent_settled', {
      type: 'agent_settled',
    });

    assert.equal(latestRun(fixture).status, 'paused');
    assert.match(
      String(latestRun(fixture).pauseReason),
      /without calling workflow_complete_step exactly once/,
    );
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the built-in prompt gate loops through feedback and approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-prompt-gate-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
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
    assert.ok(start);
    assert.ok(completion);
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
      assert.equal(fixture.sentUserMessages.length, 2);
    });
    assert.match(fixture.sentUserMessages[1] ?? '', /Add a rollback check/);

    await completion.execute('completion-2', {
      outcome: 'submit',
      summary: 'Revised plan',
      artifact: '# Plan v2',
    });
    await emitLifecycle(fixture, 'agent_settled', {
      type: 'agent_settled',
    });
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'completed');
    });
    assert.equal(latestRun(fixture).reviewedArtifact, '# Plan v2');
    assert.equal(latestRun(fixture).gateFeedback, '');
    assert.equal(plannotatorRequests, 0);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a dismissed built-in review stays pending and reopens on resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-prompt-pause-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeMainWorkflow(directory, true);
    const fixture = createHarnessFixture(directory);
    fixture.selectResponses.push(undefined);

    await initialize(fixture);
    const start = fixture.commands.get('main-workflow');
    const resume = fixture.commands.get('workflow-resume');
    const completion = fixture.tools.get('workflow_complete_step');
    assert.ok(start);
    assert.ok(resume);
    assert.ok(completion);
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
      assert.equal(latestRun(fixture).status, 'paused');
    });
    assert.equal(
      (latestRun(fixture).pendingGate as { provider?: string }).provider,
      'prompt',
    );

    fixture.selectResponses.push('Approve');
    await resume('', fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'completed');
    });
    assert.equal(latestRun(fixture).reviewedArtifact, '# Pending plan');
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the harness delegates a step and advances only from its correlated child result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    let delegatedRequest: SubagentDelegationRequest | undefined;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      delegatedRequest = data as SubagentDelegationRequest;
      assert.deepEqual(fixture.activeTools(), []);
      const extracted = extractChildPolicy(delegatedRequest.task);
      assert.ok(extracted);
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
      fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: delegatedRequest.requestId,
        status: 'completed',
      });
    });

    await initialize(fixture);
    const start = fixture.commands.get('delegate');
    assert.ok(start);
    await start('the repository', fixture.context);

    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'completed');
    });
    assert.equal(delegatedRequest?.agent, 'pi-workflows.step');
    assert.equal(delegatedRequest?.context, 'fresh');
    assert.equal(delegatedRequest?.skill, false);
    assert.deepEqual(delegatedRequest?.acceptance, {
      level: 'none',
      reason:
        'Pi Workflows owns correlated step completion and human-review gates',
    });
    assert.deepEqual(fixture.activeTools(), ['read', 'bash']);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a delegated child cannot return a gate resolution outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeGatedWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    let gateRequests = 0;
    let delegatedPolicy: ChildStepPolicy | undefined;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      const request = data as SubagentDelegationRequest;
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
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
    assert.ok(start);
    await start('the change', fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'paused');
    });

    assert.deepEqual(delegatedPolicy?.outcomes, ['blocked', 'submit']);
    assert.equal(gateRequests, 0);
    assert.equal(latestRun(fixture).currentStepId, 'plan');
    assert.equal(latestRun(fixture).pendingGate, undefined);
    assert.deepEqual(latestRun(fixture).history, []);
    assert.match(
      String(latestRun(fixture).pauseReason),
      /invalid outcome "approved"/,
    );
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('pause cancels the active child, ignores its late response, and resumes the same step', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    const requests: SubagentDelegationRequest[] = [];
    let firstResultWritten: Promise<void> | undefined;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as SubagentDelegationRequest;
      requests.push(request);
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
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
    assert.ok(start);
    assert.ok(pause);
    assert.ok(resume);
    await start('the repository', fixture.context);
    assert.ok(firstResultWritten);
    await firstResultWritten;

    const pausing = pause('repair workflow definition', fixture.context);
    await eventually(() => {
      assert.deepEqual(cancellations, [requests[0]?.requestId]);
      assert.equal(requests.length, 1);
    });
    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: 'cancelled',
    });
    await pausing;
    assert.equal(latestRun(fixture).status, 'paused');
    assert.equal(latestRun(fixture).currentStepId, 'inspect');
    assert.deepEqual(cancellations, [requests[0]?.requestId]);
    assert.deepEqual(fixture.activeTools(), ['read', 'bash']);

    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: 'completed',
    });
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'paused');
    });

    await resume('', fixture.context);
    await eventually(() => {
      assert.equal(requests.length, 2);
      assert.equal(latestRun(fixture).status, 'completed');
    });
    assert.equal(
      extractChildPolicy(requests[1]?.task ?? '')?.policy.stepId,
      'inspect',
    );
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a local delegation timeout keeps main tools and resume blocked until terminal response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
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
      assert.ok(extracted);
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
    assert.ok(start);
    assert.ok(resume);
    await start('the repository', fixture.context);
    assert.equal(requests.length, 1);
    assert.deepEqual(fixture.activeTools(), []);

    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'paused');
      assert.deepEqual(cancellations, [requests[0]?.requestId]);
    });
    assert.deepEqual(fixture.activeTools(), []);

    await resume('', fixture.context);
    assert.equal(requests.length, 1);
    assert.deepEqual(fixture.activeTools(), []);

    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: 'cancelled',
    });
    await eventually(() => {
      assert.deepEqual(fixture.activeTools(), ['read', 'bash']);
    });

    await resume('', fixture.context);
    await eventually(() => {
      assert.equal(requests.length, 2);
      assert.equal(latestRun(fixture).status, 'completed');
    });
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy checkpoints do not derive approved Bash commands from lastSummary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
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
    assert.ok(workflow);
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
    assert.ok(resume);
    await resume('', fixture.context);
    await eventually(() => {
      assert.ok(delegatedPolicy);
    });
    assert.equal(delegatedPolicy?.approvedBashCommands, undefined);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a reviewed gate artifact alone grants the next child exact remote commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeGatedPublishWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    const approvedCommand =
      'glab api projects/1/merge_requests/2/notes -f body=approved';
    const unreviewedCommand =
      'glab api projects/1/merge_requests/2/notes -f body=unreviewed';
    const policies: ChildStepPolicy[] = [];
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      const request = data as SubagentDelegationRequest;
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
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
                actions: [
                  {
                    toolName: 'bash',
                    input: { command: approvedCommand },
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
    assert.ok(start);
    await start('the merge request', fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'awaiting-gate');
    });
    fixture.events.emit(PLANNOTATOR_RESULT_CHANNEL, {
      reviewId: 'review-exact-command',
      approved: true,
      feedback: 'Approved',
    });
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'completed');
      assert.equal(policies.length, 2);
    });
    assert.deepEqual(policies[1]?.approvedBashCommands, [approvedCommand]);
    assert.equal(
      policies[1]?.approvedBashCommands?.includes(unreviewedCommand),
      false,
    );
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Plannotator results are serialized behind pause and retained for resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-harness-'));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeGatedWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    let childRequests = 0;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      childRequests += 1;
      const request = data as SubagentDelegationRequest;
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
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
    assert.ok(start);
    assert.ok(pause);
    assert.ok(resume);
    await start('the change', fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'awaiting-gate');
      assert.equal(
        (latestRun(fixture).pendingGate as { reviewId?: string }).reviewId,
        'review-serialized',
      );
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
      assert.equal(run.status, 'paused');
      const pendingGate = run.pendingGate as {
        resolution?: { approved?: boolean };
      };
      assert.equal(pendingGate.resolution?.approved, true);
    });
    assert.equal(childRequests, 1);

    await resume('', fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, 'completed');
    });
    assert.equal(
      latestRun(fixture).stepHandoff,
      '# Plan\n\nImplement carefully.',
    );
    assert.equal(
      latestRun(fixture).reviewedArtifact,
      '# Plan\n\nImplement carefully.',
    );
    assert.equal(
      latestRun(fixture).lastSummary,
      '# Plan\n\nImplement carefully.',
    );
    const history = latestRun(fixture).history as Array<{ summary: string }>;
    assert.equal(history.at(-1)?.summary, '# Plan\n\nImplement carefully.');
    assert.equal(childRequests, 1);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
