import { describe, expect, test } from 'bun:test';
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { WorkflowCatalog } from '../../src/domain/index.ts';
import { advanceRun } from '../../src/function/engine/index.ts';
import { createRun, type WorkflowRun } from '../../src/domain/index.ts';
import { pauseRun } from '../../src/function/engine/index.ts';
import type { HarnessActionContext } from '../../src/infrastructure/harness/action-context.ts';
import { createEmptyCatalog } from '../../src/infrastructure/harness/catalog.ts';
import { createCoreActions } from '../../src/infrastructure/harness/core-actions.ts';
import { createPauseActions } from '../../src/infrastructure/harness/pause-actions.ts';
import { loadedWorkflow } from '../helpers.ts';

type Notice = {
  message: string;
  level: string;
};

function createExtensionContext(
  notices: Array<Notice>,
  branch: Array<unknown> = [],
): ExtensionContext {
  return {
    cwd: '/project',
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify: (message: string, level: string) => {
        notices.push({ message, level });
      },
    },
  } as unknown as ExtensionContext;
}

function createCoreFixture() {
  const notices: Array<Notice> = [];
  const calls = {
    launched: 0,
    persistenceEvents: [] as Array<string>,
    persisted: 0,
    registered: [] as Array<string>,
    restoredTools: 0,
    sentMessages: [] as Array<{
      customType: string;
      content: string;
      display?: boolean;
    }>,
    statusUpdates: 0,
    toolSets: [] as Array<Array<string>>,
  };
  const fixture = {
    activeDelegation: undefined,
    availableSkills: new Set<string>(),
    catalog: createEmptyCatalog(),
    catalogLoadSequence: 0,
    dependencies: {
      flushUnwrittenSession: () => {
        calls.persistenceEvents.push('flush');
        return true;
      },
      loadCatalog: async () => createEmptyCatalog(),
      now: () => 10,
    },
    isSessionActive: true,
    latestContext: createExtensionContext(notices),
    mainSteps: {
      release: () => {},
    },
    mutationQueue: {
      run: async (operation: () => Promise<void>) => operation(),
    },
    pi: {
      appendEntry: () => {
        calls.persistenceEvents.push('append');
      },
      getActiveTools: () => ['read'],
      getAllTools: () => [{ name: 'read' }],
      getCommands: () => [] as Array<{ name: string }>,
      registerCommand: (name: string) => {
        calls.registered.push(name);
      },
      sendMessage: (message: {
        customType: string;
        content: string;
        display?: boolean;
      }) => {
        calls.sentMessages.push(message);
      },
      setActiveTools: (tools: Array<string>) => {
        calls.toolSets.push(tools);
      },
    },
    registeredWorkflowCommands: new Set<string>(),
    run: undefined as WorkflowRun | undefined,
    sessionEpoch: 2,
    statusShortcut: 'ctrl+alt+w',
    isolateMainSessionTools: () => {
      calls.toolSets.push([]);
    },
    launchCurrentStep: () => {
      calls.launched += 1;
    },
    persist: () => {
      calls.persisted += 1;
    },
    preflight: () => [] as Array<string>,
    restoreBaselineTools: () => {
      calls.restoredTools += 1;
    },
    start: async () => {},
    updateStatus: () => {
      calls.statusUpdates += 1;
    },
  };
  return { calls, fixture, notices };
}

function createCommandContext(notices: Array<Notice>): ExtensionCommandContext {
  return {
    isIdle: () => true,
    ui: {
      notify: (message: string, level: string) => {
        notices.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
}

describe('when testing core actions', () => {
  const actions = createCoreActions();

  test('materializes a fresh Pi session immediately after appending a checkpoint', () => {
    const workflow = loadedWorkflow();
    const { calls, fixture } = createCoreFixture();
    fixture.run = createRun(workflow, '', ['read'], 'run-1', 1);

    actions.persist.call(fixture as unknown as HarnessActionContext);

    expect(calls.persistenceEvents).toEqual(['append', 'flush']);
  });

  test('fails a running transition whose next step fails preflight', () => {
    const workflow = loadedWorkflow();
    const { calls, fixture, notices } = createCoreFixture();
    fixture.run = advanceRun(
      workflow,
      createRun(workflow, '', ['read'], 'run-1', 1),
      'ready',
      'Inspection is complete',
      2,
    );
    fixture.preflight = () => ['required skill is unavailable'];

    actions.settleAfterTransition.call(
      fixture as unknown as HarnessActionContext,
      workflow,
      {
        stepId: 'inspect',
        outcome: 'ready',
        summary: 'Inspection is complete',
      },
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      failedStepId: 'implement',
      pauseReason: 'Step preflight failed: required skill is unavailable',
    });
    expect(calls).toMatchObject({
      launched: 0,
      persisted: 1,
      restoredTools: 1,
      statusUpdates: 1,
    });
    expect(notices.at(-1)?.message).toContain('Workflow paused');
    expect(calls.sentMessages).toHaveLength(2);
    expect(calls.sentMessages[0]?.content).toContain('Inspection is complete');
    expect(calls.sentMessages[1]?.content).toContain(
      'Step preflight failed: required skill is unavailable',
    );
  });

  test('rejects mutations before initialization and after a session switch', async () => {
    const inactive = createCoreFixture();
    const inactiveContext = createExtensionContext(inactive.notices);
    inactive.fixture.isSessionActive = false;
    let operationCalls = 0;

    await actions.enqueueMutation.call(
      inactive.fixture as unknown as HarnessActionContext,
      inactiveContext,
      async () => {
        operationCalls += 1;
      },
    );
    expect(operationCalls).toBe(0);
    expect(inactive.notices.at(-1)?.message).toContain('still initializing');

    const switched = createCoreFixture();
    const switchedContext = createExtensionContext(switched.notices);
    switched.fixture.mutationQueue.run = async (operation) => {
      switched.fixture.sessionEpoch += 1;
      await operation();
    };
    await actions.enqueueMutation.call(
      switched.fixture as unknown as HarnessActionContext,
      switchedContext,
      async () => {
        operationCalls += 1;
      },
    );
    expect(operationCalls).toBe(0);
    expect(switched.notices.at(-1)?.message).toContain('superseded');
  });

  test('rejects an invalid restored checkpoint', () => {
    const { calls, fixture, notices } = createCoreFixture();
    const context = createExtensionContext(notices, [
      {
        type: 'custom',
        customType: 'pi-workflows-state-v1',
        data: { stateVersion: 99 },
      },
    ]);

    actions.restoreFromSession.call(
      fixture as unknown as HarnessActionContext,
      context,
    );

    expect(fixture.run).toBeUndefined();
    expect(notices.at(-1)?.message).toContain('checkpoint is invalid');
    expect(calls.restoredTools).toBe(1);
    expect(calls.statusUpdates).toBe(1);
  });

  test('pauses a running checkpoint restored from the session', () => {
    const workflow = loadedWorkflow();
    const run = createRun(workflow, 'request', ['read'], 'run-1', 1);
    const { calls, fixture, notices } = createCoreFixture();
    const context = createExtensionContext(notices, [
      {
        type: 'custom',
        customType: 'pi-workflows-state-v1',
        data: run,
      },
    ]);

    actions.restoreFromSession.call(
      fixture as unknown as HarnessActionContext,
      context,
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      pauseReason:
        'Session was restored; inspect the checkpoint before resuming',
    });
    expect(calls.persisted).toBe(1);
    expect(calls.restoredTools).toBe(1);
    expect(calls.sentMessages.at(-1)?.content).toContain(
      'Session was restored; inspect the checkpoint before resuming',
    );
  });

  test('discards a stale catalog load', async () => {
    const { fixture, notices } = createCoreFixture();
    const context = createExtensionContext(notices);
    fixture.dependencies.loadCatalog = async () => {
      fixture.catalogLoadSequence += 1;
      return createEmptyCatalog();
    };

    const result = await actions.reloadCatalog.call(
      fixture as unknown as HarnessActionContext,
      context,
      false,
    );

    expect(result).toBe(false);
  });

  test('removes workflows whose commands conflict at runtime', async () => {
    const workflow = loadedWorkflow();
    const { calls, fixture, notices } = createCoreFixture();
    const context = createExtensionContext(notices);
    const catalog: WorkflowCatalog = {
      workflows: new Map([[workflow.definition.id, workflow]]),
      settings: {
        version: 1,
        allowProjectWorkflows: false,
        statusShortcut: 'ctrl+alt+w',
      },
      diagnostics: [],
      userDirectory: '/workflows',
    };
    fixture.dependencies.loadCatalog = async () => catalog;
    fixture.pi.getCommands = () => [{ name: 'example' }];

    const result = await actions.reloadCatalog.call(
      fixture as unknown as HarnessActionContext,
      context,
      false,
    );

    expect(result).toBe(true);
    expect(fixture.catalog.workflows.size).toBe(0);
    expect(fixture.catalog.diagnostics[0]?.message).toContain('conflicts');
    expect(calls.registered).toEqual([]);
    expect(notices.at(-1)?.message).toContain('Workflow configuration errors');
  });
});

describe('when testing pause actions', () => {
  const actions = createPauseActions();

  test('reports when there is no active workflow to pause or abort', async () => {
    const { fixture, notices } = createCoreFixture();
    const context = createCommandContext(notices);

    await actions.pauseNow.call(
      fixture as unknown as HarnessActionContext,
      'manual pause',
      context,
    );
    await actions.abortNow.call(
      fixture as unknown as HarnessActionContext,
      'manual abort',
      context,
    );

    expect(notices).toEqual([
      { message: 'No active workflow to pause', level: 'warning' },
      { message: 'No active workflow to abort', level: 'warning' },
    ]);
  });

  test('reports an already paused workflow and preserves its reason', async () => {
    const workflow = loadedWorkflow();
    const { fixture, notices } = createCoreFixture();
    fixture.run = pauseRun(
      createRun(workflow, '', ['read'], 'run-1', 1),
      'waiting for review',
      2,
    );

    await actions.pauseNow.call(
      fixture as unknown as HarnessActionContext,
      'different reason',
      createCommandContext(notices),
    );

    expect(fixture.run.pauseReason).toBe('waiting for review');
    expect(notices.at(-1)).toEqual({
      message: 'Workflow is already paused: waiting for review',
      level: 'info',
    });
  });
});
