import { describe, expect, test } from 'bun:test';
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { createRun } from '../src/engine/state.ts';
import { advanceRun } from '../src/engine/transitions.ts';
import type { HarnessActionContext } from '../src/harness/action-context.ts';
import { createStartActions } from '../src/harness/start-actions.ts';
import { createDelegationPlan } from '../src/harness/delegation-plan.ts';
import type { WorkflowStartContext } from '../src/harness/types.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

type Notice = {
  message: string;
  level: string;
};

function createCommandContext(
  options: {
    idle?: boolean;
    onWaitForIdle?: () => void;
  } = {},
): {
  context: ExtensionCommandContext;
  notices: Array<Notice>;
  abortCount: () => number;
} {
  const notices: Array<Notice> = [];
  let abortCount = 0;
  return {
    context: {
      cwd: '/workspace/run',
      abort: () => {
        abortCount += 1;
      },
      getSystemPromptOptions: () => ({
        skills: [{ name: 'workflow-skill' }],
      }),
      isIdle: () => options.idle ?? true,
      isProjectTrusted: () => true,
      waitForIdle: async () => {
        options.onWaitForIdle?.();
      },
      ui: {
        notify: (message: string, level: string) => {
          notices.push({ message, level });
        },
      },
    } as unknown as ExtensionCommandContext,
    notices,
    abortCount: () => abortCount,
  };
}

function createStartFixture() {
  const workflow = loadedWorkflow();
  const calls = {
    capturedSkills: [] as Array<string>,
    doctorLoads: 0,
    launched: 0,
    persisted: 0,
    reloaded: 0,
    sentMessages: [] as Array<unknown>,
    statusUpdates: 0,
    toolIsolations: 0,
  };
  const fixture = {
    activeDelegation: undefined,
    catalog: {
      workflows: new Map([[workflow.definition.id, workflow]]),
      settings: {
        version: 1 as const,
        allowProjectWorkflows: false,
        statusShortcut: 'ctrl+alt+w' as const,
      },
      diagnostics: [] as Array<{
        level: 'warning' | 'error';
        path: string;
        message: string;
      }>,
      userDirectory: '/workflows',
    },
    dependencies: {
      createRequestId: () => 'run-1',
      loadCatalog: async () => {
        calls.doctorLoads += 1;
        return fixture.catalog;
      },
      now: () => 10,
      resolveWorkspaceDirectory: ({ candidateCwd }: { candidateCwd: string }) =>
        candidateCwd,
    },
    isSessionActive: true,
    sessionEpoch: 3,
    run: undefined,
    pi: {
      getActiveTools: () => ['read', 'bash'],
      sendMessage: (message: unknown) => {
        calls.sentMessages.push(message);
      },
    },
    captureSkills: (skills: ReadonlyArray<{ name: string }> | undefined) => {
      calls.capturedSkills.push(...(skills ?? []).map(({ name }) => name));
    },
    isolateMainSessionTools: () => {
      calls.toolIsolations += 1;
    },
    launchCurrentStep: () => {
      calls.launched += 1;
    },
    persist: () => {
      calls.persisted += 1;
    },
    preflight: () => [] as Array<string>,
    reloadCatalog: async () => {
      calls.reloaded += 1;
      return true;
    },
    updateStatus: () => {
      calls.statusUpdates += 1;
    },
  };
  return { calls, fixture, workflow };
}

function startContext(
  context: ExtensionCommandContext,
  onWaitForIdle: () => void = () => {},
): WorkflowStartContext {
  return {
    context: context as ExtensionContext,
    skills: () => [{ name: 'workflow-skill' }],
    waitForIdle: async () => {
      onWaitForIdle();
    },
  };
}

describe('when testing start actions', () => {
  const actions = createStartActions();

  test('lists workflows and explains an empty catalog', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();

    await actions.listWorkflows.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );

    expect(calls.sentMessages).toHaveLength(1);
    expect(calls.sentMessages[0]).toMatchObject({
      customType: 'workflow-list',
      display: true,
    });

    fixture.catalog = {
      ...fixture.catalog,
      workflows: new Map(),
      diagnostics: [
        {
          level: 'error',
          path: '/workflows/example.yaml',
          message: 'invalid',
        },
      ],
    };
    await actions.listWorkflows.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)).toEqual({
      message: 'No workflows loaded from /workflows',
      level: 'warning',
    });
  });

  test('diagnoses one workflow, all workflows, and missing selections', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();

    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      'example',
      command.context,
    );
    expect(calls.sentMessages.at(-1)).toMatchObject({
      customType: 'workflow-doctor',
      display: true,
    });
    expect(calls.sentMessages.at(-1)).toMatchObject({
      content: expect.stringContaining('Result: PASS'),
    });

    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      '',
      command.context,
    );
    expect(calls.sentMessages).toHaveLength(2);

    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      'missing',
      command.context,
    );
    expect(command.notices.at(-1)).toEqual({
      message: 'Workflow "missing" is not loaded',
      level: 'error',
    });

    fixture.catalog.workflows.clear();
    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      '',
      command.context,
    );
    expect(command.notices.at(-1)).toEqual({
      message: 'No workflows loaded from /workflows',
      level: 'info',
    });
    expect(calls.doctorLoads).toBe(4);
  });

  test('diagnoses workflow edits from a freshly loaded catalog', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();
    const edited = baseWorkflow();
    edited.steps = {
      choose: {
        prompt: 'Choose',
        transitions: { finish: '$done', trap: 'trap' },
      },
      trap: {
        prompt: 'Trap',
        transitions: { wait: '$pause' },
      },
    };
    edited.start = 'choose';
    const freshWorkflow = loadedWorkflow(edited);
    fixture.dependencies.loadCatalog = async () => {
      calls.doctorLoads += 1;
      return {
        ...fixture.catalog,
        workflows: new Map([[freshWorkflow.definition.id, freshWorkflow]]),
      };
    };

    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      freshWorkflow.definition.id,
      command.context,
    );

    expect(calls.doctorLoads).toBe(1);
    const content = (calls.sentMessages.at(-1) as { readonly content: string })
      .content;
    expect(content).toContain('Result: ERROR');
    expect(content).toContain('reachable step trap cannot reach $done');
  });

  test('reports diagnostics from the freshly loaded catalog', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();
    fixture.dependencies.loadCatalog = async () => {
      calls.doctorLoads += 1;
      return {
        ...fixture.catalog,
        workflows: new Map(),
        diagnostics: [
          {
            level: 'error' as const,
            path: '/workflows/example.workflow.yaml',
            message: 'fresh validation failure',
          },
        ],
      };
    };

    await actions.doctorWorkflows.call(
      fixture as unknown as HarnessActionContext,
      '',
      command.context,
    );

    expect(calls.doctorLoads).toBe(1);
    expect(command.notices).toContainEqual({
      message:
        'Workflow configuration errors:\n' +
        '/workflows/example.workflow.yaml: fresh validation failure',
      level: 'warning',
    });
    expect(command.notices.at(-1)).toEqual({
      message: 'No workflows loaded from /workflows',
      level: 'warning',
    });
    expect(calls.sentMessages).toEqual([]);
  });

  test('rejects delegation and active-run conflicts', async () => {
    const { fixture, workflow } = createStartFixture();
    const command = createCommandContext();
    const context = startContext(command.context);

    fixture.activeDelegation = { agent: 'worker' } as never;
    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      'example',
      'request',
      context,
      3,
    );
    expect(command.notices.at(-1)?.message).toContain('still cancelling');

    fixture.activeDelegation = undefined;
    fixture.run = createRun(workflow, '', [], 'existing', 1) as never;
    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      'example',
      'request',
      context,
      3,
    );
    expect(command.notices.at(-1)?.message).toContain('resume or abort');
  });

  test('stops a busy start superseded by a session change', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext({ idle: false });
    const context = startContext(command.context, () => {
      fixture.sessionEpoch += 1;
    });

    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      'example',
      'request',
      context,
      3,
    );

    expect(command.abortCount()).toBe(1);
    expect(calls.reloaded).toBe(0);
    expect(command.notices.at(-1)?.message).toContain('session change');
  });

  test('rejects stale reloads, later session changes, and missing workflows', async () => {
    const command = createCommandContext();

    const stale = createStartFixture();
    stale.fixture.reloadCatalog = async () => false;
    await actions.startNow.call(
      stale.fixture as unknown as HarnessActionContext,
      'example',
      '',
      startContext(command.context),
      3,
    );
    expect(command.notices.at(-1)?.message).toContain(
      'newer configuration load',
    );

    const switched = createStartFixture();
    switched.fixture.reloadCatalog = async () => {
      switched.fixture.sessionEpoch += 1;
      return true;
    };
    await actions.startNow.call(
      switched.fixture as unknown as HarnessActionContext,
      'example',
      '',
      startContext(command.context),
      3,
    );
    expect(command.notices.at(-1)?.message).toContain('session change');

    const missing = createStartFixture();
    missing.fixture.catalog.workflows.clear();
    await actions.startNow.call(
      missing.fixture as unknown as HarnessActionContext,
      'missing',
      '',
      startContext(command.context),
      3,
    );
    expect(command.notices.at(-1)).toEqual({
      message: 'Workflow "missing" is not loaded',
      level: 'error',
    });
  });

  test('reports preflight errors before creating a run', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();
    fixture.preflight = () => ['read tool is unavailable'];

    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      'example',
      '',
      startContext(command.context),
      3,
    );

    expect(fixture.run).toBeUndefined();
    expect(calls.persisted).toBe(0);
    expect(command.notices.at(-1)?.message).toContain(
      'read tool is unavailable',
    );
  });

  test('refuses a workflow with a reachable non-completing branch', async () => {
    const raw = baseWorkflow();
    raw.steps = {
      choose: {
        prompt: 'Choose',
        transitions: { finish: '$done', trap: 'trap' },
      },
      trap: {
        prompt: 'Trap',
        transitions: { wait: '$pause' },
      },
    };
    raw.start = 'choose';
    const workflow = loadedWorkflow(raw);
    const { calls, fixture } = createStartFixture();
    fixture.catalog.workflows = new Map([[workflow.definition.id, workflow]]);
    const command = createCommandContext();

    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      workflow.definition.id,
      '',
      startContext(command.context),
      3,
    );

    expect(fixture.run).toBeUndefined();
    expect(calls.persisted).toBe(0);
    expect(command.notices.at(-1)?.message).toContain(
      '/workflow-doctor example',
    );
    expect(command.notices.at(-1)?.message).toContain(
      'reachable step trap cannot reach $done',
    );
  });

  test('carries a configured tool budget into the signed child policy', () => {
    const raw = baseWorkflow();
    const inspect = (raw.steps as Record<string, Record<string, unknown>>)
      .inspect!;
    inspect.maxToolCalls = 10;
    const workflow = loadedWorkflow(raw);
    const run = createRun(
      workflow,
      'Inspect the repository',
      [],
      'budgeted-run',
      1,
      '/workspace/run',
    );
    const step = workflow.definition.steps.inspect;
    if (!step) throw new Error('inspect step is missing');

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: { cwd: '/workspace/run' } as ExtensionContext,
      },
      {
        createRequestId: () => 'budgeted-child',
        createDelegationWorkspace: () => ({
          resultDirectory: '/tmp/pi-workflows-budgeted-child',
          capabilityPath: '/tmp/pi-workflows-budgeted-child/capability',
          capabilityToken: 'a'.repeat(64),
          resultPath: '/tmp/pi-workflows-budgeted-child/result.json',
        }),
        resolveWorkspaceDirectory: ({ candidateCwd }) => candidateCwd,
      },
    );

    expect(plan).toMatchObject({
      kind: 'ready',
      active: {
        policy: {
          maxToolCalls: 10,
          handoffReserve: 2,
          totalToolCalls: 12,
        },
      },
    });
  });

  test('creates a trimmed run and launches its first step', async () => {
    const { calls, fixture } = createStartFixture();
    const command = createCommandContext();

    await actions.startNow.call(
      fixture as unknown as HarnessActionContext,
      'example',
      '  inspect this  ',
      startContext(command.context),
      3,
    );

    expect(fixture.run).toMatchObject({
      runId: 'run-1',
      input: 'inspect this',
      baselineTools: ['read', 'bash'],
      cwd: '/workspace/run',
    });
    expect(calls).toMatchObject({
      capturedSkills: ['workflow-skill'],
      launched: 1,
      persisted: 1,
      reloaded: 1,
      statusUpdates: 1,
      toolIsolations: 1,
    });
  });

  test('restarts a completed iteration with its stable run identity', async () => {
    const { calls, fixture, workflow } = createStartFixture();
    const command = createCommandContext();
    let completed = createRun(
      workflow,
      'first iteration request',
      ['read'],
      'stable-run',
      1,
      '/workspace/run',
    );
    completed = advanceRun(workflow, completed, 'ready', 'Inspected', 2);
    completed = advanceRun(workflow, completed, 'done', 'Completed', 3);
    fixture.run = completed as never;

    await actions.restartNow.call(
      fixture as unknown as HarnessActionContext,
      '',
      startContext(command.context),
      3,
    );

    expect(fixture.run).toMatchObject({
      runId: 'stable-run',
      iteration: 2,
      input: 'first iteration request',
      status: 'running',
      currentStepId: 'inspect',
      history: [],
      lastSummary: 'Completed',
    });
    expect(calls).toMatchObject({
      launched: 1,
      persisted: 1,
      reloaded: 1,
      statusUpdates: 1,
      toolIsolations: 1,
    });
  });

  test('reloads only when no workflow is actively executing', async () => {
    const { calls, fixture, workflow } = createStartFixture();
    const command = createCommandContext();
    fixture.run = createRun(workflow, '', [], 'running', 1) as never;

    await actions.reloadNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(calls.reloaded).toBe(0);
    expect(command.notices.at(-1)?.message).toContain('Pause the workflow');

    fixture.run = undefined;
    await actions.reloadNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(calls.reloaded).toBe(1);
    expect(calls.capturedSkills).toEqual(['workflow-skill']);
  });
});
