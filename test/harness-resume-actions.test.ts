import { describe, expect, test } from 'bun:test';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow } from '../src/config/types.ts';
import {
  attachGateReviewId,
  beginGate,
  pauseRun,
  storeGateResolution,
} from '../src/engine/transitions.ts';
import { createRun, type WorkflowRun } from '../src/engine/state.ts';
import type { PlannotatorStatusResponse } from '../src/integrations/plannotator.ts';
import type { HarnessActionContext } from '../src/harness/action-context.ts';
import { createResumeAction } from '../src/harness/resume-action.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

type Notice = {
  message: string;
  level: string;
};

function gatedWorkflow(provider: 'prompt' | 'plannotator'): LoadedWorkflow {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  const inspect = steps.inspect!;
  if (provider === 'plannotator') {
    const permissions = inspect.permissions as Record<string, unknown>;
    const requirements = inspect.requires as Record<string, unknown>;
    permissions.extensions = ['plannotator'];
    requirements.extensions = ['plannotator'];
  }
  inspect.gate = {
    provider,
    submitOutcome: 'submit',
    approvedOutcome: 'ready',
    rejectedOutcome: 'blocked',
    ...(provider === 'plannotator' ? { timeoutMs: 1_000 } : {}),
  };
  return loadedWorkflow(raw);
}

function pausedRun(workflow: LoadedWorkflow = loadedWorkflow()): WorkflowRun {
  return pauseRun(
    createRun(workflow, 'request', ['read', 'bash'], 'run-1', 1),
    'inspect before continuing',
    2,
  );
}

function pausedGateRun(
  workflow: LoadedWorkflow,
  reviewId?: string,
): WorkflowRun {
  let run = beginGate(
    workflow,
    createRun(workflow, 'request', ['read'], 'run-1', 1),
    'submit',
    '# Plan',
    'gate-request',
    2,
  );
  if (reviewId) run = attachGateReviewId(run, reviewId, 3);
  return pauseRun(run, 'inspect review', 4);
}

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
      abort: () => {
        abortCount += 1;
      },
      getSystemPromptOptions: () => ({
        skills: [{ name: 'resume-skill' }],
      }),
      isIdle: () => options.idle ?? true,
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

function createResumeFixture(
  run: WorkflowRun,
  workflow: LoadedWorkflow,
  statusResponse: PlannotatorStatusResponse = {
    status: 'handled',
    result: { status: 'pending' },
  },
) {
  const calls = {
    capturedSkills: [] as Array<string>,
    launched: 0,
    persisted: 0,
    promptReviews: 0,
    reloads: 0,
    restoredTools: 0,
    statusRequests: 0,
    statusUpdates: 0,
    toolIsolations: 0,
  };
  let now = 10;
  const fixture = {
    activeDelegation: undefined as { agent: string } | undefined,
    catalog: {
      workflows: new Map<string, LoadedWorkflow>([
        [workflow.definition.id, workflow],
      ]),
    },
    dependencies: {
      createRequestId: () => 'status-request',
      now: () => {
        now += 1;
        return now;
      },
      requestPlannotatorReviewStatus: async () => {
        calls.statusRequests += 1;
        return statusResponse;
      },
    },
    isSessionActive: true,
    pi: { events: {} },
    run: run as WorkflowRun | undefined,
    sessionEpoch: 7,
    captureSkills: (skills: ReadonlyArray<{ name: string }> | undefined) => {
      calls.capturedSkills.push(...(skills ?? []).map(({ name }) => name));
    },
    isolateMainSessionTools: () => {
      calls.toolIsolations += 1;
    },
    launchCurrentStep: () => {
      calls.launched += 1;
    },
    launchPromptReview: () => {
      calls.promptReviews += 1;
    },
    persist: () => {
      calls.persisted += 1;
    },
    preflight: () => [] as Array<string>,
    reloadCatalog: async () => {
      calls.reloads += 1;
      return true;
    },
    restoreBaselineTools: () => {
      calls.restoredTools += 1;
    },
    updateStatus: () => {
      calls.statusUpdates += 1;
    },
  };
  return { calls, fixture };
}

describe('when testing resume actions', () => {
  const action = createResumeAction();

  test('rejects missing runs and in-flight delegation cancellation', async () => {
    const workflow = loadedWorkflow();
    const missing = createResumeFixture(pausedRun(workflow), workflow);
    const command = createCommandContext();
    missing.fixture.run = undefined;

    await action.resumeNow.call(
      missing.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toBe(
      'No paused workflow to resume',
    );

    const delegated = createResumeFixture(pausedRun(workflow), workflow);
    delegated.fixture.activeDelegation = { agent: 'worker' };
    await action.resumeNow.call(
      delegated.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toContain('still cancelling');
  });

  test('stops when idle waiting or catalog reload supersedes the checkpoint', async () => {
    const workflow = loadedWorkflow();
    const waiting = createResumeFixture(pausedRun(workflow), workflow);
    const busyCommand = createCommandContext({
      idle: false,
      onWaitForIdle: () => {
        waiting.fixture.sessionEpoch += 1;
      },
    });

    await action.resumeNow.call(
      waiting.fixture as unknown as HarnessActionContext,
      busyCommand.context,
    );
    expect(busyCommand.abortCount()).toBe(1);
    expect(waiting.calls.reloads).toBe(0);
    expect(busyCommand.notices.at(-1)?.message).toContain('superseded');

    const reloading = createResumeFixture(pausedRun(workflow), workflow);
    reloading.fixture.reloadCatalog = async () => {
      reloading.fixture.sessionEpoch += 1;
      return true;
    };
    const reloadCommand = createCommandContext();
    await action.resumeNow.call(
      reloading.fixture as unknown as HarnessActionContext,
      reloadCommand.context,
    );
    expect(reloadCommand.notices.at(-1)?.message).toContain('superseded');
  });

  test('reports a missing workflow and an unreconcilable current step', async () => {
    const workflow = loadedWorkflow();
    const command = createCommandContext();
    const missing = createResumeFixture(pausedRun(workflow), workflow);
    missing.fixture.catalog.workflows.clear();

    await action.resumeNow.call(
      missing.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toContain('no longer loaded');

    const invalidRun: WorkflowRun = {
      ...pausedRun(workflow),
      workflowDigest: 'old-digest',
      currentStepId: 'removed',
      currentStepDigest: 'old-step',
      visits: { removed: 1 },
    };
    const invalid = createResumeFixture(invalidRun, workflow);
    await action.resumeNow.call(
      invalid.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toContain(
      'current step "removed" was removed',
    );
  });

  test('resumes a runnable step and enforces its preflight', async () => {
    const workflow = loadedWorkflow();
    const command = createCommandContext();
    const runnable = createResumeFixture(pausedRun(workflow), workflow);

    await action.resumeNow.call(
      runnable.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(runnable.fixture.run?.status).toBe('running');
    expect(runnable.calls).toMatchObject({
      launched: 1,
      persisted: 1,
      statusUpdates: 1,
      toolIsolations: 1,
    });
    expect(runnable.calls.capturedSkills).toEqual(['resume-skill']);

    const blocked = createResumeFixture(pausedRun(workflow), workflow);
    blocked.fixture.preflight = () => ['required tool is unavailable'];
    await action.resumeNow.call(
      blocked.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(blocked.fixture.run).toMatchObject({
      status: 'paused',
      failedStepId: 'inspect',
    });
    expect(blocked.calls.launched).toBe(0);
    expect(command.notices.at(-1)?.message).toContain(
      'required tool is unavailable',
    );
  });

  test('reopens a paused prompt review and preserves a pending remote review', async () => {
    const promptWorkflow = gatedWorkflow('prompt');
    const prompt = createResumeFixture(
      pausedGateRun(promptWorkflow),
      promptWorkflow,
    );
    const command = createCommandContext();

    await action.resumeNow.call(
      prompt.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(prompt.fixture.run?.status).toBe('awaiting-gate');
    expect(prompt.calls.promptReviews).toBe(1);
    expect(command.notices.at(-1)?.message).toContain('built-in review open');

    const remoteWorkflow = gatedWorkflow('plannotator');
    const remote = createResumeFixture(
      pausedGateRun(remoteWorkflow, 'review-1'),
      remoteWorkflow,
    );
    await action.resumeNow.call(
      remote.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(remote.fixture.run?.status).toBe('awaiting-gate');
    expect(remote.calls.statusRequests).toBe(1);
    expect(command.notices.at(-1)?.message).toContain(
      'waiting for review review-1',
    );
  });

  test('retries a Plannotator gate interrupted before recording its review id', async () => {
    const workflow = gatedWorkflow('plannotator');
    const { calls, fixture } = createResumeFixture(
      pausedGateRun(workflow),
      workflow,
    );

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      createCommandContext().context,
    );

    expect(fixture.run).toMatchObject({
      status: 'running',
      gateFeedback:
        'Gate submission was interrupted before a review id was recorded; submit it again',
    });
    expect(calls.statusRequests).toBe(0);
    expect(calls.launched).toBe(1);
  });

  test('reports an unavailable Plannotator status without changing the pause', async () => {
    const workflow = gatedWorkflow('plannotator');
    const { fixture } = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
      { status: 'error', error: 'status service failed' },
    );
    const command = createCommandContext();

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );

    expect(fixture.run?.status).toBe('paused');
    expect(command.notices.at(-1)).toEqual({
      message: 'status service failed',
      level: 'error',
    });
  });

  test('applies a completed review and reports its terminal transition', async () => {
    const workflow = gatedWorkflow('plannotator');
    const { calls, fixture } = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
      {
        status: 'handled',
        result: {
          status: 'completed',
          reviewId: 'review-1',
          approved: false,
          feedback: 'revise the plan',
        },
      },
    );
    const command = createCommandContext();

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      gateFeedback: 'revise the plan',
    });
    expect(calls.restoredTools).toBe(1);
    expect(command.notices.at(-1)?.message).toBe('Workflow is now paused');
  });

  test('retries a review missing from Plannotator', async () => {
    const workflow = gatedWorkflow('plannotator');
    const { calls, fixture } = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
      { status: 'handled', result: { status: 'missing' } },
    );

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      createCommandContext().context,
    );

    expect(fixture.run).toMatchObject({
      status: 'running',
      gateFeedback:
        'Plannotator no longer has the pending review; submit it again',
    });
    expect(calls.launched).toBe(1);
  });

  test('rejects state and catalog changes during a status request', async () => {
    const workflow = gatedWorkflow('plannotator');
    const command = createCommandContext();
    const switched = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
    );
    switched.fixture.dependencies.requestPlannotatorReviewStatus = async () => {
      switched.fixture.sessionEpoch += 1;
      return { status: 'handled', result: { status: 'pending' } };
    };

    await action.resumeNow.call(
      switched.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toContain('superseded');

    const vanished = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
    );
    vanished.fixture.dependencies.requestPlannotatorReviewStatus = async () => {
      vanished.fixture.catalog.workflows.clear();
      return { status: 'handled', result: { status: 'pending' } };
    };
    await action.resumeNow.call(
      vanished.fixture as unknown as HarnessActionContext,
      command.context,
    );
    expect(command.notices.at(-1)?.message).toContain('no longer loaded');
  });

  test('reports reconciliation changes discovered after a status request', async () => {
    const workflow = gatedWorkflow('plannotator');
    const { fixture } = createResumeFixture(
      pausedGateRun(workflow, 'review-1'),
      workflow,
    );
    const removedStepWorkflow: LoadedWorkflow = {
      ...workflow,
      digest: 'changed-workflow',
      definition: {
        ...workflow.definition,
        steps: {},
      },
    };
    fixture.dependencies.requestPlannotatorReviewStatus = async () => {
      fixture.catalog.workflows.set('example', removedStepWorkflow);
      return { status: 'handled', result: { status: 'pending' } };
    };
    const command = createCommandContext();

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );

    expect(command.notices.at(-1)?.message).toContain(
      'current step "inspect" was removed',
    );
  });

  test('reports a stored gate result that no longer matches configuration', async () => {
    const workflow = gatedWorkflow('prompt');
    const stored = storeGateResolution(
      pausedGateRun(workflow),
      { approved: true, feedback: '', resolvedAt: 5 },
      5,
    );
    const { fixture } = createResumeFixture(stored, workflow);
    const ungatedInspect = { ...workflow.definition.steps.inspect! };
    delete ungatedInspect.gate;
    const withoutGate: LoadedWorkflow = {
      ...workflow,
      definition: {
        ...workflow.definition,
        steps: {
          ...workflow.definition.steps,
          inspect: ungatedInspect,
        },
      },
    };
    fixture.catalog.workflows.set('example', withoutGate);
    const command = createCommandContext();

    await action.resumeNow.call(
      fixture as unknown as HarnessActionContext,
      command.context,
    );

    expect(fixture.run?.status).toBe('paused');
    expect(command.notices.at(-1)?.message).toContain(
      'gated step "inspect" no longer exists',
    );
  });
});
